// shared/stageCatalog.d.mts
export type StageParamSpec =
  | { kind: 'boolean'; zh: string }
  | { kind: 'number'; min: number; max: number; zh: string }
  | { kind: 'select'; options: (string | number)[]; zh: string };
export const SONNET_CAMERA_INTENSITY_MAX: 0.7;
export const MODE_PARAMS: Record<string, { setter: string | null; params: Record<string, StageParamSpec> }>;
