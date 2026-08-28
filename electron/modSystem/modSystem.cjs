// electron/modSystem/modSystem.cjs
// The Folia mod loader: discovers mods from the mods directories, validates
// manifests, resolves dependencies, activates each mod in a sandboxed error
// boundary, and bridges declared commands/rendering into the renderer over IPC.
// Designed to fail per-mod instead of crashing the host application.

'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, protocol, shell } = require('electron');
const Store = require('electron-store').default || require('electron-store');
const { unzipSync } = require('fflate');

const { validateManifest, resolveLoadOrder } = require('./manifest.cjs');
const { createModApi } = require('./modApi.cjs');
const { resolveFfmpeg } = require('./ffmpeg.cjs');
const { createExportService } = require('./exportService.cjs');
const { attachModProtocolHandler } = require('./modProtocol.cjs');

const SETTINGS_NAMESPACE = 'mods';
const EXPORT_PERMISSION = 'render.export';

const IPC = {
    list: 'folia-mods:list',
    setEnabled: 'folia-mods:set-enabled',
    reload: 'folia-mods:reload',
    invoke: 'folia-mods:invoke',
    pushRuntimeSnapshot: 'folia-mods:push-runtime-snapshot',
    exportCancel: 'folia-mods:export-cancel',
    ffmpegStatus: 'folia-mods:ffmpeg-status',
    openDirectory: 'folia-mods:open-directory',
    installZip: 'folia-mods:install-zip',
    fStateChanged: 'folia-mods:state-changed',
    fExportProgress: 'folia-mods:export-progress',
    fLog: 'folia-mods:log',
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const serializeError = (error) => {
    if (!error) {
        return 'unknown error';
    }
    return error && error.message ? error.message : String(error);
};

const createModSystem = ({ app, BrowserWindow, getMainWindow }) => {
    let store = null;
    try {
        store = new Store({ name: 'mod-system' });
    } catch {
        // electron-store may fail in odd environments; degrade to a no-op store
        // so the loader itself can still run in-memory.
        const memory = new Map();
        store = {
            get: (key) => memory.get(key),
            set: (key, value) => { memory.set(key, value); },
        };
    }

    const enabledKey = (modId) => `${SETTINGS_NAMESPACE}.enabled.${modId}`;

    const mods = new Map();       // modId -> runtime entry
    let runtimeSnapshot = null;   // last snapshot pushed by the renderer
    let ffmpegStatus = { available: false, path: null, version: null, candidates: [] };
    let ffmpegProbePromise = null;

    const getMainWindowSafe = () => {
        try {
            return typeof getMainWindow === 'function' ? getMainWindow() : null;
        } catch {
            return null;
        }
    };

    const sendToRenderer = (channel, payload) => {
        const win = getMainWindowSafe();
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send(channel, payload);
        }
    };

    const emitLog = (modId, level, message, details) => {
        const [method, fallback] = level === 'warn' ? ['warn', console.warn] : level === 'error' ? ['error', console.error] : ['log', console.log];
        (typeof console[method] === 'function' ? console[method] : fallback)(`[Mod:${modId}] ${message}`, details ?? '');
        sendToRenderer(IPC.fLog, { modId, level, message: String(message), details: details ? serializeError(details) : undefined });
    };

    const buildModRuntime = (manifest, entries) => {
        const dataDir = path.join(app.getPath('userData'), 'mods-data', manifest.id);
        let modApi = null;
        const commandRegistry = new Map();

        const context = {
            modId: manifest.id,
            manifest,
            dataDir,
            emitLog: (level, message, details) => emitLog(manifest.id, level, message, details),
            getRuntimeSnapshot: () => (runtimeSnapshot ? cloneJson(runtimeSnapshot) : null),
            registerCommand: (command) => {
                if (commandRegistry.has(command.id)) {
                    throw new Error(`duplicate command id "${command.id}"`);
                }
                commandRegistry.set(command.id, command);
            },
            requestExport: (spec) => {
                if (!manifest.permissions.includes(EXPORT_PERMISSION)) {
                    return Promise.reject(new Error(`permission-denied:${EXPORT_PERMISSION}`));
                }
                return exportService.runExport({
                    modId: manifest.id,
                    spec,
                    onProgress: (progress) => {
                        sendToRenderer(IPC.fExportProgress, { modId: manifest.id, ...progress });
                    },
                });
            },
        };

        modApi = createModApi(context);

        const load = () => {
            const entryPath = path.join(entries.dirPath, manifest.entry);
            // Drop the cache entry so reloads re-execute the mod entry with a
            // fresh command registry instead of returning stale contributions.
            delete require.cache[require.resolve(entryPath)];
            const moduleFactory = require(entryPath);
            if (typeof moduleFactory !== 'function') {
                throw new Error(`mod entry must export a function, got ${typeof moduleFactory}`);
            }
            moduleFactory(modApi);
        };

        return { load, getCommands: () => commandRegistry };
    };

    const publicModState = (runtime) => {
        const entry = mods.get(runtime.manifest.id);
        if (!entry) {
            return null;
        }
        const commands = Array.from(entry.getCommands().values()).map((command) => ({
            id: command.id,
            label: cloneJson(command.label ?? { 'zh-CN': command.id }),
            description: cloneJson(command.description ?? {}),
            params: cloneJson(command.params ?? []),
            permissions: cloneJson(command.permissions ?? []),
        }));
        // Visualizer contributions are only exposed for mods that are enabled
        // and loaded; the protocol handler enforces the same rule per request.
        const visualizers = entry.status === 'loaded' && Array.isArray(entry.manifest.visualizers)
            ? entry.manifest.visualizers.map((visualizer) => ({
                id: visualizer.id,
                mode: `mod:${entry.manifest.id}:${visualizer.id}`,
                entry: visualizer.entry,
                url: `folia-mod://${entry.manifest.id}/${visualizer.entry}`,
                label: cloneJson(visualizer.label ?? {}),
                order: visualizer.order,
            }))
            : [];
        return {
            id: entry.manifest.id,
            name: entry.manifest.name,
            version: entry.manifest.version,
            author: entry.manifest.author,
            description: entry.manifest.description,
            permissions: entry.manifest.permissions,
            status: entry.status,
            error: entry.error,
            enabled: entry.enabled,
            commands,
            visualizers,
        };
    };

    const getModsDirectories = () => {
        const directories = [];
        const repoMods = path.join(app.getAppPath(), 'mods');
        // In production the packaged app is read-only; user-installed mods live
        // under userData and packaged mods under resources.
        const isPackaged = app.isPackaged;
        if (!isPackaged) {
            directories.push(repoMods);
        }
        directories.push(path.join(app.getPath('userData'), 'mods'));
        if (process.resourcesPath) {
            directories.push(path.join(process.resourcesPath, 'mods'));
        }
        return directories;
    };

    const readManifestFiles = () => {
        const discovered = new Map();
        const seenIds = new Set();
        getModsDirectories().forEach((dirPath) => {
            let dirEntries = [];
            try {
                dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
            } catch {
                return; // Directory missing — nothing to discover here.
            }
            dirEntries.filter((entry) => entry.isDirectory()).forEach((entry) => {
                const modDirectory = path.join(dirPath, entry.name);
                const manifestPath = path.join(modDirectory, 'mod.json');
                let raw = null;
                try {
                    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                } catch (error) {
                    const existing = discovered.get(entry.name) ?? { dirPath: modDirectory, manifest: null, validationErrors: null };
                    if (!existing.validationErrors) {
                        existing.validationErrors = [`cannot read mod.json: ${serializeError(error)}`];
                        discovered.set(entry.name, existing);
                    }
                    return;
                }
                const validation = validateManifest(raw);
                if (!validation.ok) {
                    discovered.set(entry.name, { dirPath: modDirectory, manifest: null, validationErrors: validation.errors });
                    return;
                }
                const manifest = validation.value;
                if (seenIds.has(manifest.id)) {
                    discovered.set(`${entry.name}-duplicate-${manifest.id}`, {
                        dirPath: modDirectory,
                        manifest,
                        validationErrors: [`duplicate mod id "${manifest.id}"`],
                    });
                    return;
                }
                seenIds.add(manifest.id);
                discovered.set(manifest.id, { dirPath: modDirectory, manifest, validationErrors: null });
            });
        });
        return discovered;
    };

    /*
     * Full load cycle: discover, validate, resolve dependency order, then
     * activate each entry in order inside per-mod error boundaries. Returns the
     * renderer-facing state list. Re-entrant: reloads replace previous state.
     */
    const loadAll = () => {
        const discovered = readManifestFiles();
        const manifestsById = new Map();
        const failures = [];

        discovered.forEach((discovery, key) => {
            if (!discovery.manifest) {
                failures.push({
                    id: key,
                    name: key,
                    version: null,
                    author: null,
                    description: null,
                    permissions: [],
                    status: 'error',
                    error: (discovery.validationErrors ?? ['invalid manifest']).join('; '),
                    enabled: true,
                    commands: [],
                });
                return;
            }
            manifestsById.set(discovery.manifest.id, discovery.manifest);
        });

        const orderResult = resolveLoadOrder(manifestsById);
        if (!orderResult.ok) {
            // Dependency graph broken: every mod that made it into the graph is
            // surfaced with the failure so users see exactly what is missing.
            manifestsById.forEach((manifest) => {
                failures.push({
                    id: manifest.id,
                    name: manifest.name,
                    version: manifest.version,
                    author: manifest.author,
                    description: manifest.description,
                    permissions: manifest.permissions,
                    status: 'dependency-failed',
                    error: orderResult.errors.join('; '),
                    enabled: isModEnabled(manifest.id),
                    commands: [],
                });
            });
            mods.clear();
            failures.forEach((entry) => {
                mods.set(entry.id, {
                    manifest: { id: entry.id, name: entry.name, version: entry.version ?? '0.0.0', permissions: entry.permissions },
                    status: entry.status,
                    error: entry.error,
                    enabled: entry.enabled,
                    getCommands: () => new Map(),
                });
            });
            notifyStateChanged();
            return listMods();
        }

        const nextMods = new Map();
        orderResult.order.forEach((modId) => {
            const discovery = discovered.get(modId);
            const manifest = discovery.manifest;
            const runtime = {
                manifest,
                dirPath: discovery.dirPath,
                status: 'disabled',
                error: null,
                enabled: isModEnabled(modId),
                ...buildModRuntime(manifest, discovery),
            };
            if (!runtime.enabled) {
                nextMods.set(modId, runtime);
                return;
            }
            try {
                runtime.load();
                runtime.status = 'loaded';
            } catch (error) {
                runtime.status = 'error';
                runtime.error = serializeError(error);
            }
            nextMods.set(modId, runtime);
        });

        mods.clear();
        nextMods.forEach((runtime, modId) => mods.set(modId, runtime));
        notifyStateChanged();
        return listMods();
    };

    const isModEnabled = (modId) => {
        try {
            const stored = store.get(enabledKey(modId));
            return stored === undefined ? true : Boolean(stored);
        } catch {
            return true;
        }
    };

    const setModEnabled = (modId, enabled) => {
        try {
            store.set(enabledKey(modId), Boolean(enabled));
        } catch {
            // Persistence is best-effort; in-memory state still applies.
        }
        const runtime = mods.get(modId);
        if (!runtime) {
            loadAll();
            return listMods();
        }
        runtime.enabled = Boolean(enabled);
        loadAll();
        return listMods();
    };

    const invokeModCommand = async (modId, commandId, params) => {
        const runtime = mods.get(modId);
        if (!runtime) {
            return { ok: false, error: 'mod-not-found' };
        }
        if (runtime.status !== 'loaded') {
            return { ok: false, error: 'mod-not-loaded' };
        }
        const command = runtime.getCommands().get(commandId);
        if (!command) {
            return { ok: false, error: 'command-not-found' };
        }
        const missingPermissions = (command.permissions ?? []).filter(
            (permission) => !runtime.manifest.permissions.includes(permission)
        );
        if (missingPermissions.length > 0) {
            return { ok: false, error: `permission-denied:${missingPermissions.join(',')}` };
        }
        try {
            const result = await command.run(params ?? {}, { snapshot: runtimeSnapshot ? cloneJson(runtimeSnapshot) : null });
            return { ok: true, result };
        } catch (error) {
            emitLog(modId, 'error', `command ${commandId} failed`, error);
            return { ok: false, error: serializeError(error) };
        }
    };

    const listMods = () => Array.from(mods.values())
        .map((runtime) => publicModState(runtime))
        .filter(Boolean)
        .sort((left, right) => left.id.localeCompare(right.id));

    // The per-user writable mod directory (the packaged app's own tree is read-only).
    const getUserModsDirectory = () => path.join(app.getPath('userData'), 'mods');

    const openModsDirectory = async () => {
        try {
            const target = getUserModsDirectory();
            fs.mkdirSync(target, { recursive: true });
            const error = await shell.openPath(target);
            if (error) {
                return { ok: false, error: `open-directory-failed:${error}` };
            }
            return { ok: true, directory: target };
        } catch (error) {
            return { ok: false, error: serializeError(error) };
        }
    };

    /**
     * Installs a mod from a .zip into the per-user mod directory. The zip may
     * carry mod.json at its root or under exactly one top-level folder; the mod
     * lands at <userData>/mods/<manifest.id>, replacing any existing copy, then
     * the loader reloads. Zip-slip is blocked and the manifest is validated
     * before anything is written to the destination.
     */
    const installModFromZip = async (zipPath) => {
        if (typeof zipPath !== 'string' || !zipPath.toLowerCase().endsWith('.zip')) {
            return { ok: false, error: 'install-not-zip' };
        }

        let archive;
        try {
            archive = unzipSync(fs.readFileSync(zipPath));
        } catch {
            return { ok: false, error: 'install-corrupt-zip' };
        }

        // Normalize + sanitize entry paths (reject traversal and absolute paths).
        const entries = [];
        for (const [rawPath, bytes] of Object.entries(archive)) {
            if (rawPath.endsWith('/')) continue; // directory marker
            const segments = rawPath.split('/').filter((segment) => segment !== '' && segment !== '.');
            if (segments.some((segment) => segment === '..' || segment.includes('\\'))) {
                return { ok: false, error: 'install-unsafe-path' };
            }
            if (path.isAbsolute(segments.join(path.sep))) {
                return { ok: false, error: 'install-unsafe-path' };
            }
            entries.push({ segments, bytes });
        }
        if (entries.length === 0) {
            return { ok: false, error: 'install-empty-zip' };
        }

        // Locate the manifest root: mod.json at root, or under a single top-level folder.
        const manifestEntries = entries.filter((entry) => entry.segments[entry.segments.length - 1] === 'mod.json');
        let rootDepth = 0;
        if (!manifestEntries.some((entry) => entry.segments.length === 1)) {
            const roots = new Set(manifestEntries.map((entry) => entry.segments[0]));
            if (roots.size !== 1) {
                return { ok: false, error: 'install-no-manifest' };
            }
            rootDepth = 1;
        }
        const manifestEntry = manifestEntries.find((entry) => entry.segments.length === rootDepth + 1);
        if (!manifestEntry) {
            return { ok: false, error: 'install-no-manifest' };
        }

        let manifest;
        try {
            manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
        } catch {
            return { ok: false, error: 'install-invalid-manifest' };
        }
        const validation = validateManifest(manifest);
        if (!validation.ok) {
            return { ok: false, error: `install-invalid-manifest:${validation.errors.join('; ')}` };
        }

        const modId = validation.value.id;
        const target = path.join(getUserModsDirectory(), modId);
        try {
            // Replace an existing copy so dragging an updated zip performs an upgrade.
            fs.rmSync(target, { recursive: true, force: true });
            fs.mkdirSync(target, { recursive: true });
            for (const entry of entries) {
                if (entry.segments[rootDepth + 1] === undefined) {
                    continue; // the manifest root itself is covered by mkdir
                }
                const relative = entry.segments.slice(rootDepth).join(path.sep);
                const destination = path.resolve(target, relative);
                if (destination !== target && !destination.startsWith(target + path.sep)) {
                    throw new Error('unsafe destination');
                }
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.writeFileSync(destination, Buffer.from(entry.bytes));
            }
            loadAll();
            emitLog(modId, 'info', `installed mod ${modId} from zip`);
            return { ok: true, id: modId, mods: listMods() };
        } catch (error) {
            // Best-effort clean-up so a failed install never leaves a half-written mod dir.
            try {
                fs.rmSync(target, { recursive: true, force: true });
            } catch {
                // Nothing else to do.
            }
            return { ok: false, error: serializeError(error) };
        }
    };

    const notifyStateChanged = () => sendToRenderer(IPC.fStateChanged, listMods());

    const probeFfmpeg = () => {
        if (!ffmpegProbePromise) {
            ffmpegProbePromise = resolveFfmpeg({ appGetAppPath: () => app.getAppPath() })
                .then((status) => {
                    ffmpegStatus = status;
                    return status;
                })
                .finally(() => {
                    ffmpegProbePromise = null;
                });
        }
        return ffmpegProbePromise;
    };

    const exportService = createExportService({
        app,
        BrowserWindow,
        resolveFfmpeg: probeFfmpeg,
    });

    // folia-mod:// resolves only enabled, successfully loaded mods. Disabled
    // or broken mods disappear from the protocol on the next loadAll pass.
    const resolveModDirectory = (modId) => {
        const runtime = mods.get(modId);
        return runtime && runtime.status === 'loaded' && runtime.dirPath ? runtime.dirPath : null;
    };
    attachModProtocolHandler(protocol, resolveModDirectory);

    const registerIpc = () => {
        const handle = (channel, handler) => {
            try {
                ipcMain.removeHandler(channel);
            } catch {
                // First registration has nothing to remove.
            }
            ipcMain.handle(channel, async (event, ...args) => {
                try {
                    return await handler(event, ...args);
                } catch (error) {
                    return { ok: false, error: serializeError(error) };
                }
            });
        };

        handle(IPC.list, () => ({ mods: listMods(), ffmpeg: ffmpegStatus, directories: getModsDirectories() }));
        handle(IPC.setEnabled, (_event, modId, enabled) => ({ mods: setModEnabled(modId, enabled) }));
        handle(IPC.reload, () => ({ mods: loadAll() }));
        handle(IPC.exportCancel, () => ({ ok: exportService.cancelActiveExport() }));
        handle(IPC.invoke, (_event, modId, commandId, params) => invokeModCommand(modId, commandId, params));
        handle(IPC.pushRuntimeSnapshot, (_event, snapshot) => {
            if (snapshot && typeof snapshot === 'object') {
                runtimeSnapshot = snapshot;
            }
            return { ok: true };
        });
        handle(IPC.ffmpegStatus, async () => ({ ffmpeg: await probeFfmpeg() }));
        handle(IPC.openDirectory, () => openModsDirectory());
        handle(IPC.installZip, (_event, zipPath) => installModFromZip(zipPath));
    };

    const dispose = () => {
        exportService.cancelActiveExport();
    };

    return {
        loadAll,
        listMods,
        setModEnabled,
        probeFfmpeg,
        registerIpc,
        dispose,
        IPC,
    };
};

module.exports = { createModSystem, IPC };