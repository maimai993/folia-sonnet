import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { normalizeStageIdentity } from './stageIdentity.js';
import { canonicalStageJson, validateStagePayload } from './stagePayload.js';

// sync-server/src/stageMigrationPreview.ts
// 仅对显式本地SQLite与元数据JSONL作只读预演，不联网、不写数据库、不猜测艺人。
// archive行契约：{key,title,artists:[string],payload}，必须与现存旧键内容一致。
export const previewStageMigration = async (databasePath: string, archivePath: string) => {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const counts = { inspected: 0, malformed: 0, missingIdentity: 0, missingLegacy: 0, contentMismatch: 0, invalidPayload: 0, conflictingIdentity: 0 };
  const candidates = new Map<string, { identityKey: string; legacyKeys: string[]; content: string }>();
  const conflicts = new Set<string>();
  try {
    const lookup = db.prepare("SELECT payload_json FROM ai_cache WHERE kind = 'stage' AND cache_key = ?");
    const lines = createInterface({ input: createReadStream(archivePath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      counts.inspected++;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { counts.malformed++; continue; }
      if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || !/^[a-f0-9]{32}$/.test(entry.key)) { counts.malformed++; continue; }
      const identity = normalizeStageIdentity(entry);
      if (!identity) { counts.missingIdentity++; continue; }
      const row = lookup.get(entry.key) as { payload_json: string } | undefined;
      if (!row) { counts.missingLegacy++; continue; }
      let legacy: unknown;
      try { legacy = JSON.parse(row.payload_json); } catch { counts.invalidPayload++; continue; }
      const parsed = validateStagePayload(legacy);
      if (!parsed) { counts.invalidPayload++; continue; }
      if (!entry.payload || canonicalStageJson(entry.payload) !== parsed.json) { counts.contentMismatch++; continue; }
      const existing = candidates.get(identity.key);
      if (existing && existing.content !== parsed.json) { conflicts.add(identity.key); counts.conflictingIdentity++; continue; }
      if (existing) { if (!existing.legacyKeys.includes(entry.key)) existing.legacyKeys.push(entry.key); }
      else candidates.set(identity.key, { identityKey: identity.key, legacyKeys: [entry.key], content: parsed.json });
    }
    return { readOnly: true, counts, conflicts: [...conflicts], candidates: [...candidates.values()].filter((entry) => !conflicts.has(entry.identityKey)).map(({ content: _content, ...entry }) => entry) };
  } finally { db.close(); }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , databasePath, archivePath] = process.argv;
  if (!databasePath || !archivePath) {
    console.error('用法：Node24 stageMigrationPreview.js <本地只读SQLite路径> <显式元数据JSONL路径>');
    process.exitCode = 2;
  } else {
    previewStageMigration(databasePath, archivePath).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
