import type { CapacitorConfig } from '@capacitor/cli';

// 当前文件：Folia Android Capacitor 容器的构建与 WebView 配置。

const config: CapacitorConfig = {
  appId: 'top.izuna.foliamajor',
  appName: 'Folia',
  webDir: 'dist',
  loggingBehavior: 'debug',
  backgroundColor: '#09090b',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
    cleartext: false,
  },
  android: {
    // 酷狗 API 部署在 http://folia.tangbot.xyz:8080，WebView 页面本身走 https://localhost，
    // 属于混合内容，必须显式放行才能发起该请求（明文白名单见 AndroidManifest 的 network_security_config）。
    allowMixedContent: true,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 900,
      backgroundColor: '#09090b',
      showSpinner: false,
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'LIGHT',
      backgroundColor: '#09090b',
    },
  },
};

export default config;
