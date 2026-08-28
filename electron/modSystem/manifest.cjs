// electron/modSystem/manifest.cjs
// Pure helpers for validating mod manifests and resolving the mod dependency graph.
// No side effects on import so the logic stays unit-testable from test/unit/mod-system/.

'use strict';

const API_VERSION = 1;

// v1 permission set. Anything else is rejected at validation time so a mod
// can never claim a capability the loader does not implement (fail closed).
const KNOWN_PERMISSIONS = new Set([
    'filesystem.data',
    'render.export',
    'runtime.playback',
    'visualizer.register',
]);

const MOD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VISUALIZER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Deterministic result envelope shared by all validators.
const ok = (value) => ({ ok: true, value });
const fail = (errors) => ({ ok: false, errors });

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/*
 * Dependency strings in `depends` are either a bare mod id ("base-mod") or
 * "id@^1.2.3". Only the caret range and the wildcard are supported in apiVersion 1;
 * unsupported operators are reported as validation errors instead of being guessed.
 */
const parseDependency = (raw) => {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { ok: false, error: `invalid dependency entry ${JSON.stringify(raw)}` };
    }
    const at = raw.lastIndexOf('@');
    if (at <= 0) {
        return { ok: true, id: raw.trim(), range: null };
    }
    const id = raw.slice(0, at).trim();
    const range = raw.slice(at + 1).trim();
    if (!MOD_ID_PATTERN.test(id)) {
        return { ok: false, error: `invalid dependency id in "${raw}"` };
    }
    if (range !== '*' && !/^\^[0-9]+\.[0-9]+\.[0-9]+$/.test(range)) {
        return { ok: false, error: `unsupported version range "${range}" in "${raw}"` };
    }
    return { ok: true, id, range };
};

const parseVersion = (version) => {
    const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(String(version ?? '').trim());
    if (!match) {
        return null;
    }
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

const compareVersions = (left, right) => {
    if (left.major !== right.major) return left.major - right.major;
    if (left.minor !== right.minor) return left.minor - right.minor;
    return left.patch - right.patch;
};

const satisfiesRange = (version, range) => {
    if (!range || range === '*') {
        return true;
    }
    const parsed = parseVersion(version);
    if (!parsed) {
        return false;
    }
    if (range.startsWith('^')) {
        const min = parseVersion(range.slice(1));
        if (!min) {
            return false;
        }
        if (compareVersions(parsed, min) < 0) {
            return false;
        }
        // Caret range: same major version.
        return parsed.major === min.major;
    }
    return false;
};

/*
 * Optional `visualizers` contribution (apiVersion 1, additive): each entry is
 * { id, entry, label, order? }. The entry file is a browser ESM module loaded
 * by the renderer over the folia-mod:// protocol; it never runs in Node.
 */
const normalizeVisualizerContribution = (raw, manifest, errors) => {
    if (raw === undefined) {
        return [];
    }
    if (!Array.isArray(raw)) {
        errors.push('mod.visualizers must be an array');
        return [];
    }
    const visualizers = [];
    const seenIds = new Set();
    raw.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
            errors.push(`mod.visualizers[${index}] must be an object`);
            return;
        }
        const id = item.id;
        const entry = item.entry;
        if (typeof id !== 'string' || !VISUALIZER_ID_PATTERN.test(id)) {
            errors.push(`mod.visualizers[${index}].id must match /^[a-z0-9][a-z0-9-]*$/`);
            return;
        }
        if (seenIds.has(id)) {
            errors.push(`duplicate visualizer id "${id}"`);
            return;
        }
        seenIds.add(id);
        if (typeof entry !== 'string' || !/\.(js|mjs)$/.test(entry) || entry.includes('..') || entry.includes('\\')) {
            errors.push(`mod.visualizers "${id}".entry must be a relative .js/.mjs path inside the mod directory`);
            return;
        }
        if (!manifest.permissions.includes('visualizer.register')) {
            errors.push(`visualizer "${id}" requires the visualizer.register permission`);
            return;
        }
        visualizers.push({
            id,
            entry,
            label: item.label && typeof item.label === 'object' ? item.label : {},
            order: Number.isFinite(Number(item.order)) ? Number(item.order) : 500,
        });
    });
    return visualizers;
};

const validateManifest = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return fail(['manifest root must be a JSON object']);
    }

    const errors = [];
    const manifest = {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        apiVersion: raw.apiVersion ?? API_VERSION,
        author: raw.author ?? null,
        description: raw.description ?? null,
        entry: raw.entry ?? 'index.cjs',
        depends: Array.isArray(raw.depends) ? raw.depends : [],
        permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    };

    if (!isNonEmptyString(manifest.id) || !MOD_ID_PATTERN.test(manifest.id)) {
        errors.push('mod.id is required and must match /^[a-z0-9][a-z0-9-]*$/');
    }
    if (!isNonEmptyString(manifest.name)) {
        errors.push('mod.name is required');
    }
    if (!parseVersion(manifest.version)) {
        errors.push('mod.version must be a semantic version like 1.2.3');
    }
    if (manifest.apiVersion !== API_VERSION) {
        errors.push(`unsupported apiVersion ${String(manifest.apiVersion)}; this loader supports ${API_VERSION}`);
    }
    if (!isNonEmptyString(manifest.entry) || manifest.entry.includes('/') || manifest.entry.includes('\\')) {
        errors.push('mod.entry must be a single file name inside the mod directory');
    }
    if (typeof manifest.name === 'string' && manifest.name.length > 64) {
        errors.push('mod.name is limited to 64 characters');
    }

    const dependencyIds = new Set();
    manifest.depends.forEach((dependency) => {
        const parsed = parseDependency(dependency);
        if (!parsed.ok) {
            errors.push(parsed.error);
            return;
        }
        if (dependencyIds.has(parsed.id)) {
            errors.push(`duplicate dependency "${parsed.id}"`);
        }
        dependencyIds.add(parsed.id);
    });

    const permissionIds = new Set();
    manifest.permissions.forEach((permission) => {
        if (typeof permission !== 'string' || !KNOWN_PERMISSIONS.has(permission)) {
            errors.push(`unknown or unsupported permission ${String(permission)}`);
            return;
        }
        if (permissionIds.has(permission)) {
            errors.push(`duplicate permission "${permission}"`);
        }
        permissionIds.add(permission);
    });

    manifest.visualizers = normalizeVisualizerContribution(raw.visualizers, manifest, errors);

    return errors.length > 0 ? fail(errors) : ok(manifest);
};

/*
 * Resolves the load order for a set of validated manifests.
 * Input: Map<modId, manifest>. Output: `{ ok: true, order: [modId...] }`
 * or `{ ok: false, errors }` on missing dependencies or dependency cycles.
 */
const resolveLoadOrder = (manifests, { source = 'unknown' } = {}) => {
    const errors = [];
    const order = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (manifest) => {
        if (visited.has(manifest.id)) {
            return;
        }
        if (visiting.has(manifest.id)) {
            errors.push(`dependency cycle detected involving "${manifest.id}" in ${source}`);
            return;
        }
        visiting.add(manifest.id);
        manifest.depends.forEach((dependency) => {
            const parsed = parseDependency(dependency);
            if (!parsed.ok) {
                errors.push(parsed.error);
                return;
            }
            const target = manifests.get(parsed.id);
            if (!target) {
                errors.push(`missing dependency "${parsed.id}" required by "${manifest.id}" in ${source}`);
                return;
            }
            if (!satisfiesRange(target.version, parsed.range)) {
                errors.push(
                    `dependency "${manifest.id}" requires "${parsed.id}@${parsed.range ?? '*'}" ` +
                    `but version ${target.version} is installed in ${source}`
                );
                return;
            }
            visit(target);
        });
        visiting.delete(manifest.id);
        visited.add(manifest.id);
        order.push(manifest.id);
    };

    manifests.forEach((manifest) => visit(manifest));

    const failed = errors.length > 0;
    if (failed) {
        // A cycle, missing dependency, or version mismatch keeps the graph
        // unusable: report instead of returning a partial order that would
        // load mods against a broken contract.
        return fail(errors);
    }
    return { ok: true, order };
};

module.exports = {
    API_VERSION,
    KNOWN_PERMISSIONS,
    parseDependency,
    satisfiesRange,
    validateManifest,
    resolveLoadOrder,
};