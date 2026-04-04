/// <reference types="vite/client" />

declare const __COMMIT_HASH__: string;
declare const __GIT_BRANCH__: string;
declare const __APP_VERSION__: string;

declare global {
  interface Window {
    electron?: {
      getSettings: () => Promise<any>;
      saveSettings: (key: string, value: any) => Promise<any>;
      generateTheme: (lyricsText: string, options?: { isPureMusic?: boolean; songTitle?: string }) => Promise<any>;
      getNeteasePort: () => Promise<number>;
    };
  }
}
