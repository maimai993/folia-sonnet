import { MODE_PARAMS } from '../../shared/stageCatalog.mjs';

// sync-server/src/stagePayload.ts
// 完整公共视觉方案的纯数据验证，不加载 renderer，也不核验歌词或音频。
export const MAX_STAGE_BYTES = 64 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const color = (value: unknown): boolean => typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value);
const optionalString = (value: unknown, max = 2000): boolean => value === undefined || (typeof value === 'string' && value.length <= max);

const validTheme = (value: unknown): boolean => {
  if (!record(value)) return false;
  if (!['backgroundColor', 'primaryColor', 'accentColor', 'secondaryColor'].every((key) => color(value[key]))) return false;
  if (value.fontStyle !== undefined && !['sans', 'serif', 'mono'].includes(String(value.fontStyle))) return false;
  if (value.animationIntensity !== undefined && !['calm', 'normal', 'chaotic'].includes(String(value.animationIntensity))) return false;
  if (value.fontWeight !== undefined && (typeof value.fontWeight !== 'number' || !Number.isFinite(value.fontWeight) || value.fontWeight < 1 || value.fontWeight > 1000)) return false;
  if (!['name', 'fontFamily', 'provider', 'description'].every((key) => optionalString(value[key]))) return false;
  if (value.fontFamilyStack !== undefined && (!Array.isArray(value.fontFamilyStack) || value.fontFamilyStack.some((item) => typeof item !== 'string' || item.length > 200))) return false;
  if (value.lyricsIcons !== undefined && (!Array.isArray(value.lyricsIcons) || value.lyricsIcons.some((item) => typeof item !== 'string' || item.length > 100))) return false;
  if (value.wordColors !== undefined && (!Array.isArray(value.wordColors) || value.wordColors.some((item) => !record(item) || typeof item.word !== 'string' || !item.word.trim() || item.word.length > 500 || !color(item.color)))) return false;
  return true;
};

/** 按稳定键序列化，避免对象键顺序变化制造新内容修订。 */
export const canonicalStageJson = (value: unknown): string => JSON.stringify(value, (_key, item) => (
  record(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item
));

export const validateStagePayload = (value: unknown): { json: string; bytes: number } | null => {
  if (!record(value) || !record(value.theme) || !validTheme(value.theme.light) || !validTheme(value.theme.dark)) return null;
  const decision = value.decision;
  if (!record(decision) || typeof decision.mode !== 'string' || !Object.hasOwn(MODE_PARAMS, decision.mode)
    || !record(decision.params) || !optionalString(decision.reason)) return null;
  const specs = MODE_PARAMS[decision.mode].params;
  for (const [key, item] of Object.entries(decision.params)) {
    if (!Object.hasOwn(specs, key)) return null;
    const spec = specs[key];
    if (spec.kind === 'boolean' && typeof item !== 'boolean') return null;
    if (spec.kind === 'number' && (typeof item !== 'number' || !Number.isFinite(item) || item < spec.min || item > spec.max)) return null;
    if (spec.kind === 'select' && !spec.options.includes(item as string | number)) return null;
  }
  try {
    const json = canonicalStageJson(value);
    const bytes = new TextEncoder().encode(json).byteLength;
    return bytes <= MAX_STAGE_BYTES ? { json, bytes } : null;
  } catch { return null; }
};
