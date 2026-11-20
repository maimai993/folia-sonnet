// src/services/nativeSelfHostedServices.ts
// 把「用户自己填的自建服务地址」告诉原生授权层（issue C1 / H2）。
//
// 原生的 httpRequest 现在有主机白名单：平台域名是出厂内置的，用户自己的 NAS（飞牛、Navidrome）
// 则是用户在设置 / 登录表单里填的。原生能自己读到已经**落盘**的那一份（见
// android/.../FoliaNativeAccess.kt 的 readConfiguredServerHosts），但首次登录时地址还只在
// 这一次的输入框里 —— 那次登录用的就是它，所以要在发请求之前报给原生，让它把这台机器
// 记进「本次会话可用的自建服务」。
//
// 这里**只是登记一次的提示**，不是白名单本身：登记只在原生侧把它当成「本次会话」有效，
// 进程重启即失效；落盘的那一份永远来自用户的设置。换句话说，网页脚本调这个函数最多能
// 临时给自己的会话开一台机器，拿不到任何跨次的权限，也换不走别人的凭据。

import { Capacitor } from '@capacitor/core';

/** 原生 FoliaNativeAccess 的注册方法名（插件上是同一批 @PluginMethod 之一）。 */
type SelfHostedRegistrar = {
  registerSelfHostedService: (options: { url: string }) => Promise<{ ok?: boolean; host?: string }>;
};

const getPlugin = (): SelfHostedRegistrar | null => {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
  const capacitor = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  const plugin = capacitor?.Plugins?.FoliaNative as SelfHostedRegistrar | undefined;
  return plugin && typeof plugin.registerSelfHostedService === 'function' ? plugin : null;
};

/**
 * 报一个用户刚填进表单的自建服务地址。
 *
 * 失败一律静默：网页端 / 桌面端没有这个通道，插件还没起来或还没实现也一样 ——
 * 这时请求本来就走浏览器 fetch 或原生已经落盘的那一份，不该因为一条提示失败就中断登录。
 */
export const registerSelfHostedService = async (value: string | null | undefined): Promise<void> => {
  const url = String(value ?? '').trim();
  if (!url) return;
  const plugin = getPlugin();
  if (!plugin) return;
  try {
    await plugin.registerSelfHostedService({ url });
  } catch (error) {
    console.warn('[FoliaNative] registerSelfHostedService failed', error);
  }
};
