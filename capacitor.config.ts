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
      // 不要开 overlaysWebView：插件内部用废弃的 setSystemUiVisibility 实现，
      // 只覆盖状态栏、不覆盖导航栏，且会冲掉 MainActivity 的全沉浸设置。
      // 铺满与隐藏现在由原生侧统一负责。
      // 注意：不写这项也不行 —— StatusBarConfig 的默认值就是 true，
      // 插件构造时会自动应用，必须显式关掉。
      overlaysWebView: false,
      style: 'LIGHT',
    },
  },
};

export default config;
