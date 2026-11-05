// shared/ai/foliawork.mjs
import { PLAIN_ATTEMPTS } from './compatibleBody.mjs';

// Folia 的免费渠道：一台机器一个「机器码」，机器码就是它的 API Key。
//
// 与别的服务商只差三件事，其余全部相同：
//   · 地址写死。用户不用填、不用选站点 —— 装上就能用，这就是「默认免费」。
//   · 模型写死 `deepseek-v4.1-flash`。别让用户选：白名单里倍率为 0 的还有视频模型，
//     「免费优先」会挑到它们然后必然失败。写死一个便宜的对话模型，行为才是确定的。
//   · 密钥不是用户填的，是本机的机器码（见 src/services/foliaMachineCode.ts）。
//
// 协议就是普通的 OpenAI 兼容 `chat/completions` —— 服务端那把机器码建出来的
// 是一把普通 Key，走的是同一个网关。这里**没有**任何自定义请求/响应形状。
//
// 唯一需要用户调的是温度：它是表达偏好、又不会把功能改坏的唯一旋钮。

/** 写死的渠道地址（含 `/v1`，与其它 OpenAI 兼容服务商的填法一致）。 */
export const FOLIA_WORK_API_BASE = 'https://apiai.tangbot.xyz/v1';
/** API 根地址（不含 `/v1`）：查额度那条 `/api/folia/machine/me` 挂在这上面。 */
export const FOLIA_WORK_API_ROOT = 'https://apiai.tangbot.xyz';
/**
 * 应用内签到的验证页：koishi 插件单独开一个端口（默认 5302）提供，nginx 把 `rzai.tangbot.xyz`
 * 反代到它。路径就是机器码：`https://rzai.tangbot.xyz/sk-xxxx`。
 *
 * 为什么单独一个端口：那一页要能被 App 嵌（跨源），而主后台的 CORS 是收紧的；它的滥用面
 * 也和主后台完全不同，混在一起没法分别限流。App 用 iframe 嵌它，验证通过后它会
 * `postMessage` 回来，App 据此刷新剩余积分。
 */
export const FOLIA_CHECKIN_URL = 'https://rzai.tangbot.xyz/';
/** 写死的模型。**不要**改成 auto：见文件头。 */
/**
 * 发给服务端的模型：**`auto`**。
 *
 * 为什么不再写死一个名字：服务端要按倍率挑、失败要自动换下一个、还要跳过被封的模型 ——
 * 这些都发生在服务端。客户端写死一个名字，就等于把「挑模型」这件事锁死了，用户看到的
 * 名字也会和实际跑的模型对不上（换过了界面还写着原来那个）。
 *
 * 「这次到底用的哪个」由 `/me` 回报 `lastModel`，界面上单独显示。
 */
export const FOLIA_WORK_MODEL = 'auto';
/**
 * 「贡献账号」页：任何人都能打开，里面给出一条 /join 登录链接。
 *
 * 设置页的入口指向它，那一页上写着那句警告 —— 加进共享池的账号会被所有人一起用，
 * 有被封禁的风险；自己还要用 WorkBuddy 的话别加。
 */
export const FOLIA_WORK_SHARE_PAGE_URL = 'https://apiai.tangbot.xyz/share';

/** @type {import('./providerRegistry.mjs').AiAdapter} */
export const foliaWorkAdapter = {
    id: 'foliawork',
    // Only for the sort order; the settings form shows `options.aiProvider_foliawork`.
    label: 'Folia Free',
    // 普通的 OpenAI 兼容端点。机器码建出来的就是一把普通 Key，走的也是同一个网关 ——
    // 这里没有任何自定义请求形状，所以共用代码（buildCompatibleBody、分词 env、
    // 适配器不变量测试、安卓原生补全）全都照常适用，不用为它开例外。
    protocol: 'openai',
    hosts: ['apiai.tangbot.xyz'],
    endpoints: [{ id: 'default', baseUrl: `${FOLIA_WORK_API_BASE}` }],
    defaultModel: FOLIA_WORK_MODEL,
    recommendedModel: FOLIA_WORK_MODEL,
    // 没有模型列表可拉：只有一个模型，而且不许换。表单据此只显示建议值，不发请求。
    models: null,
    suggestedModels: [FOLIA_WORK_MODEL],
    // 温度是这个渠道唯一开放的旋钮。
    temperature: { min: 0, max: 2 },
    /*
     * 网关支持流式，所以这里如实声明 true —— 但**表单不给这个开关**（设置页对免费渠道
     * 隐藏了流式行），实际请求永远是非流式：一次主题生成就是一次请求，流式只会让
     * 「空回复」更难判。
     *
     * 为什么不用 false 声明「不支持」：`stream` 表达的是端点能力，不是当前开关。
     * 声明 false 会让适配器不变量（「openai 协议都支持流式」）不成立，而那条不变量是
     * 对真实兼容端点的正确描述 —— 该改的是表单，不是这个字段。
     */
    stream: true,
    tokenField: 'max_tokens',
    // 没有推理开关可谈：一个请求形状，不带任何 reasoning 参数。
    attempts: () => PLAIN_ATTEMPTS,
    responseFormat: () => ({ type: 'json_object' }),
};
