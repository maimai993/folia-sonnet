import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.ts';
import zhCN from './locales/zh-CN.ts';
import zhTW from 'virtual:folia-locale-zh-TW';
import ind from './locales/in.ts';
import vi from './locales/vi.ts';
import { resolveMissingTranslation } from './missingTranslation';
import { isPerfCheckSurface } from '../utils/appSurface';

/*
 * Chinese fallback for keys the active locale does not contain.
 * zh-CN is flattened when this module loads into one dotted-key map, which
 * parseMissingKeyHandler reads through resolveMissingTranslation. A repeated
 * path keeps the position of its first write and the value of its last write.
 * Arrays are indexed (`items.0`); empty objects add no keys; other leaves
 * are String(value).
 */
export function flattenLocale(obj: Record<string, any>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (node: Record<string, any>, pathPrefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const path = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (typeof value === 'object' && value !== null) {
        visit(value, path);
      } else {
        result[path] = String(value);
      }
    }
  };
  visit(obj, prefix);
  return result;
}

const ZH_FALLBACKS: Record<string, string> = flattenLocale(zhCN);

export type AppLanguagePreference = 'system' | 'en' | 'zh-CN' | 'zh-TW' | 'in' | 'vi';
export const APP_LANGUAGE_STORAGE_KEY = 'folia_app_language';

const isSupportedManualLanguage = (value: string | null | undefined): value is Exclude<AppLanguagePreference, 'system'> => (
  value === 'en' || value === 'zh-CN' || value === 'zh-TW' || value === 'in' || value === 'vi'
);

/*
 * A `zh` tag has to be split into Simplified and Traditional before it can be
 * matched to a bundle. Explicit script and region subtags win; only a bare `zh`
 * falls back to Simplified, so `zh-TW` / `zh-HK` / `zh-Hant` all land on the
 * traditional bundle while `zh-CN` / `zh-SG` / `zh` stay simplified.
 */
const normalizeChineseLanguage = (value: string): 'zh-CN' | 'zh-TW' => {
  const lowered = value.toLowerCase();
  const subtags = lowered.split('-').slice(1);

  if (subtags.some(tag => tag === 'hant' || tag === 'tw' || tag === 'hk' || tag === 'mo')) {
    return 'zh-TW';
  }

  return 'zh-CN';
};

const normalizeSupportedLanguage = (value: string | null | undefined): Exclude<AppLanguagePreference, 'system'> => {
  if (!value) {
    return 'en';
  }

  if (value === 'in' || value.toLowerCase().startsWith('id')) {
    return 'in';
  }

  if (value.toLowerCase() === 'vi' || value.toLowerCase().startsWith('vi-')) {
    return 'vi';
  }

  if (value.toLowerCase().startsWith('zh')) {
    return normalizeChineseLanguage(value);
  }

  return 'en';
};

/*
 * 有没有 localStorage 可用。
 *
 * 只判 `typeof window === 'undefined'` 不够：`window` 在、存储不在的地方是有的 —— 无痕/受限的
 * WebView、被裁掉存储的沙箱，以及测试里只为别的事 stub 了一个 window 的情形。下面几处都改用它，
 * 读不到就当没存过，别在模块求值时就抛（`initialLanguagePreference` 是模块级立即执行的）。
 */
const storageOrNull = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage ?? null;
  } catch {
    // 取 localStorage 本身就可能抛（安全策略禁掉存储时）。
    return null;
  }
};

export const readStoredAppLanguagePreference = (): AppLanguagePreference => {
  const storage = storageOrNull();
  if (!storage) {
    return 'system';
  }

  const saved = storage.getItem(APP_LANGUAGE_STORAGE_KEY);
  if (saved === 'system' || isSupportedManualLanguage(saved)) {
    return saved;
  }

  return 'system';
};

const initialLanguagePreference = readStoredAppLanguagePreference();

/*
 * The language detector used to cache whatever it resolved under `i18nextLng`, and that
 * cache outranked the system language on every later start, so "follow system" stuck on
 * the first language it ever saw. The preference has lived in folia_app_language since
 * 0af872ca and nothing reads the old key any more; drop the leftover.
 */
if (typeof window !== 'undefined') {
  try {
    localStorage.removeItem('i18nextLng');
  } catch {
    // Storage can be unavailable (privacy mode); the stale key is harmless when ignored.
  }
}

const syncDocumentLanguage = (value: string | null | undefined) => {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.lang = normalizeSupportedLanguage(value);
};

/*
 * Startup and the Settings "follow system" switch both go through this, so a system
 * language maps to the same bundle either way (zh-HK -> zh-TW, id-ID -> in). Letting
 * i18next pick at startup used its own best match instead, which sent zh-HK to zh-CN
 * and id to en.
 */
const detectSystemLanguage = (): Exclude<AppLanguagePreference, 'system'> => (
  normalizeSupportedLanguage(typeof navigator !== 'undefined' ? (navigator.languages?.[0] ?? navigator.language) : 'en')
);

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: en
      },
      'zh-CN': {
        translation: zhCN
      },
      'zh-TW': {
        translation: zhTW
      },
      in: {
        translation: ind
      },
      vi: {
        translation: vi
      }
    },
    fallbackLng: 'en',
    parseMissingKeyHandler: (key: string, defaultValue?: string): string => (
      resolveMissingTranslation(ZH_FALLBACKS, key, defaultValue)
    ),
    supportedLngs: ['en', 'zh-CN', 'zh-TW', 'in', 'vi'],
    lng: initialLanguagePreference === 'system' ? detectSystemLanguage() : initialLanguagePreference,
    interpolation: {
      escapeValue: false
    }
  });

/*
 * The Electron main process keeps its own tiny locale table for the tray menu and
 * native dialogs, and only learns the language through this IPC call. Pushing on every
 * `languageChanged` plus once at startup means a `system` preference reaches the tray
 * too, instead of only manual switches made in Settings.
 */
const pushLocaleToMainProcess = (value: string | null | undefined) => {
  // The performance check's window only reads the language; the main window tells the main process.
  if (typeof window === 'undefined' || isPerfCheckSurface) {
    return;
  }

  void window.electron?.setAppLocale?.(normalizeSupportedLanguage(value));
};

i18n.on('languageChanged', lng => {
  syncDocumentLanguage(lng);
  pushLocaleToMainProcess(lng);
});

syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
pushLocaleToMainProcess(i18n.resolvedLanguage ?? i18n.language);

export const applyAppLanguagePreference = async (
  preference: AppLanguagePreference
): Promise<Exclude<AppLanguagePreference, 'system'>> => {
  const storage = storageOrNull();
  if (storage) {
    storage.setItem(APP_LANGUAGE_STORAGE_KEY, preference);
  }

  const nextLanguage = preference === 'system' ? detectSystemLanguage() : preference;
  await i18n.changeLanguage(nextLanguage);
  if (typeof window !== 'undefined') {
    await window.electron?.setAppLocale?.(nextLanguage);
  }
  return nextLanguage;
};

export default i18n;
