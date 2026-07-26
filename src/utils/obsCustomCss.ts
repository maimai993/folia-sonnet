import { useSettingsUiStore } from '../stores/useSettingsUiStore';
import type { CappellaAvatarImage, CappellaEmojiImage } from '../types';

// src/utils/obsCustomCss.ts
// Carries the uploaded OBS assets the cfg URL cannot (an IndexedDB blob has no shareable URL) through
// the OBS Browser Source "Custom CSS" field instead: the producer downsamples each asset into a data
// URL packed as a :root custom property, and the overlay reads it back with getComputedStyle. This
// keeps the (already long) cfg URL untouched and, unlike reading IndexedDB, works for a remote OBS
// whose browser context never saw the upload.

// Downscale ceilings: the Monet pipeline rasterises the background at 1920x1080 and blurs it, so a
// smaller source is invisible; the portrait is drawn far smaller still; Cappella emojis/avatars are
// tiny on screen. All keep the base64 payload within what the OBS CSS field comfortably holds.
const BACKGROUND_MAX_SIZE = 1280;
const PORTRAIT_MAX_SIZE = 640;
const CAPPELLA_AVATAR_MAX_SIZE = 256;
const CAPPELLA_EMOJI_MAX_SIZE = 128;
const BACKGROUND_QUALITY = 0.82;

const OBS_CSS_BACKGROUND_VAR = '--folia-obs-custom-bg';
const OBS_CSS_PORTRAIT_VAR = '--folia-obs-custom-portrait';
const OBS_CSS_CAPPELLA_EMOJIS_VAR = '--folia-obs-cappella-emojis';
const OBS_CSS_CAPPELLA_AVATARS_VAR = '--folia-obs-cappella-avatars';

// {id, name, url} — the shape both Cappella packs share and the overlay consumes.
interface NamedImageAsset {
  id: string;
  name: string;
  url: string;
}

const loadImage = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  // Uploaded assets are same-origin blob: URLs, so no crossOrigin is needed; guard http(s) anyway in
  // case a future caller passes a remote source.
  if (/^https?:/i.test(src)) {
    image.crossOrigin = 'anonymous';
  }
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
  image.src = src;
});

// Re-encode a source image to a size-bounded data URL. JPEG for the opaque background (smallest);
// PNG elsewhere so an uploaded cut-out (portrait, emoji, avatar) keeps its transparency.
const encodeBoundedDataUrl = async (
  sourceUrl: string,
  maxSize: number,
  mimeType: 'image/jpeg' | 'image/png',
  quality?: number,
): Promise<string | null> => {
  const image = await loadImage(sourceUrl);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) {
    return null;
  }

  const scale = Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL(mimeType, quality);
};

// UTF-8-safe base64, chunked so a large pack never overflows the call stack. A JSON list of data URLs
// carries characters ("/;,) and non-ASCII emoji names that are awkward to escape inside a raw CSS
// string, so packing it as base64 keeps the custom-property value a single CSS-safe token.
const encodeBase64Utf8 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const decodeBase64Utf8 = (value: string): string => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
};

// Downscale every image in a pack and pack the {id, name, url} list into a base64(JSON) string, or
// null when nothing survives. id/name are preserved because the overlay keys emoji triggers by name.
const encodeImageListProperty = async (
  images: NamedImageAsset[],
  maxSize: number,
): Promise<string | null> => {
  const encoded = await Promise.all(images.map(async (image) => {
    const url = await encodeBoundedDataUrl(image.url, maxSize, 'image/png');
    return url ? { id: image.id, name: image.name, url } : null;
  }));
  const kept = encoded.filter((entry): entry is NamedImageAsset => entry !== null);
  return kept.length > 0 ? encodeBase64Utf8(JSON.stringify(kept)) : null;
};

// Build the CSS snippet the user pastes into OBS Browser Source -> Custom CSS. Returns null when no
// uploaded asset is actually in use, so callers can hide the affordance. Includes OBS's own
// transparent-body reset so the snippet is a complete drop-in replacement, not an addition.
export const buildObsCustomCss = async (): Promise<string | null> => {
  const store = useSettingsUiStore.getState();
  const usesUploadedBackground = store.monetBackgroundTuning.backgroundSource === 'uploaded-global'
    || store.nomandBackgroundTuning.imageSource === 'uploaded-global';
  const usesCustomPortrait = store.monetTuning.portraitSource === 'custom';
  const usesCustomEmojis = store.cappellaTuning.emojiPackSource === 'custom'
    && store.cappellaCustomEmojiImages.length > 0;
  const usesCustomAvatars = store.cappellaTuning.avatarSource === 'custom'
    && store.cappellaCustomAvatarImages.length > 0;

  const [backgroundDataUrl, portraitDataUrl, emojiList, avatarList] = await Promise.all([
    usesUploadedBackground && store.monetBackgroundImage
      ? encodeBoundedDataUrl(store.monetBackgroundImage.url, BACKGROUND_MAX_SIZE, 'image/jpeg', BACKGROUND_QUALITY)
      : null,
    usesCustomPortrait && store.monetPortraitImage
      ? encodeBoundedDataUrl(store.monetPortraitImage.url, PORTRAIT_MAX_SIZE, 'image/png')
      : null,
    usesCustomEmojis ? encodeImageListProperty(store.cappellaCustomEmojiImages, CAPPELLA_EMOJI_MAX_SIZE) : null,
    usesCustomAvatars ? encodeImageListProperty(store.cappellaCustomAvatarImages, CAPPELLA_AVATAR_MAX_SIZE) : null,
  ]);

  const declarations: string[] = [];
  if (backgroundDataUrl) {
    declarations.push(`  ${OBS_CSS_BACKGROUND_VAR}: url("${backgroundDataUrl}");`);
  }
  if (portraitDataUrl) {
    declarations.push(`  ${OBS_CSS_PORTRAIT_VAR}: url("${portraitDataUrl}");`);
  }
  if (emojiList) {
    declarations.push(`  ${OBS_CSS_CAPPELLA_EMOJIS_VAR}: "${emojiList}";`);
  }
  if (avatarList) {
    declarations.push(`  ${OBS_CSS_CAPPELLA_AVATARS_VAR}: "${avatarList}";`);
  }

  if (declarations.length === 0) {
    return null;
  }

  return [
    '/* Folia OBS custom assets. Paste into OBS Browser Source -> Custom CSS. */',
    'body { background-color: rgba(0, 0, 0, 0); margin: 0; overflow: hidden; }',
    ':root {',
    ...declarations,
    '}',
    '',
  ].join('\n');
};

// Pull the data URL out of a `url("data:...")` custom-property value. Returns null for anything that
// is not a data URL (empty property, hand-edited CSS), so the overlay only ever adopts a real asset.
export const parseObsCssDataUrl = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const match = value.match(/url\(\s*["']?(data:[^"')]+)["']?\s*\)/);
  return match ? match[1] : null;
};

// Decode a base64(JSON) image-list custom property back into {id, name, url} entries. Any decode /
// shape failure yields an empty list so a hand-mangled CSS field can never throw in the overlay.
export const parseObsCssImageList = (value: string | null | undefined): NamedImageAsset[] => {
  if (!value) {
    return [];
  }
  const stripped = value.trim().replace(/^["']|["']$/g, '');
  if (!stripped) {
    return [];
  }
  try {
    const parsed = JSON.parse(decodeBase64Utf8(stripped));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry) => entry && typeof entry.url === 'string' && entry.url.startsWith('data:'))
      .map((entry) => ({ id: String(entry.id ?? ''), name: String(entry.name ?? ''), url: entry.url as string }));
  } catch {
    return [];
  }
};

export interface ObsCustomCssAssets {
  backgroundUrl: string | null;
  portraitUrl: string | null;
  cappellaEmojis: CappellaEmojiImage[];
  cappellaAvatars: CappellaAvatarImage[];
}

// Consumer side (OBS overlay): read the assets OBS injected via the Custom CSS field. Absent field ->
// empty, i.e. fall back to the previous cover-derived / builtin-pack behaviour.
export const readObsCustomCssAssets = (): ObsCustomCssAssets => {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return { backgroundUrl: null, portraitUrl: null, cappellaEmojis: [], cappellaAvatars: [] };
  }
  const style = getComputedStyle(document.documentElement);
  return {
    backgroundUrl: parseObsCssDataUrl(style.getPropertyValue(OBS_CSS_BACKGROUND_VAR)),
    portraitUrl: parseObsCssDataUrl(style.getPropertyValue(OBS_CSS_PORTRAIT_VAR)),
    cappellaEmojis: parseObsCssImageList(style.getPropertyValue(OBS_CSS_CAPPELLA_EMOJIS_VAR)),
    cappellaAvatars: parseObsCssImageList(style.getPropertyValue(OBS_CSS_CAPPELLA_AVATARS_VAR)),
  };
};
