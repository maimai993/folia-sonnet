// src/mods/builtin/builtinRpc.ts
// 内置模组的 `folium.rpc.call`：安卓端没有 Electron 主进程，`invokeModRpc` 只会回 `no-electron-bridge`
// （src/mods/ipc.ts），模组的数据方法就没人回答。这里给随包的模组在渲染进程里备一份处理表，
// `folium.rpc.call` 先问它、问不到再走主进程（folium/api.ts）。接线只有这一处：
// 一个模组一个加载函数，表本身由那个功能的目录提供，不在别处拼。

/** 一张处理表：方法名 → 处理函数，参数就是 `folium.rpc.call` 剩下的实参。 */
export type BuiltinRpcTable = Readonly<Record<string, (args: readonly unknown[]) => unknown>>;

/** 和 `invokeModRpc` 的回话同形：`ok` 为真时结果在 `result`，否则原因在 `error`。 */
export interface BuiltinRpcResult {
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: string;
}

/**
 * 每个内置模组自己的处理表，按需加载：没用到的模组不进主包。
 *
 * 听歌档案曾经有一份渲染进程侧的 `archive.*` 实现（src/services/listeningArchive/archiveRpc.ts）。
 * 那份是当初误判它「只有 client、没有 main」时补的桥；原始包其实带 `"main": "index.cjs"`，
 * 十个 `archive.*` 方法全由它自己回答。留着反而遮住模组自己的实现，所以删掉了。
 */
const TABLES: Readonly<Record<string, () => Promise<BuiltinRpcTable>>> = {};

const loaded = new Map<string, BuiltinRpcTable>();

/**
 * 问这个内置模组自己的处理表。没有这张表（不是内置模组，或者它不提供任何方法）时返回 null，
 * 调用方接着问主进程；表里没有这个方法时按失败回话，免得悄悄落到主进程去。
 */
export const callBuiltinRpc = async (
    modId: string,
    name: string,
    args: readonly unknown[],
): Promise<BuiltinRpcResult | null> => {
    const load = TABLES[modId];
    if (!load) return null;
    let table = loaded.get(modId);
    if (!table) {
        table = await load();
        loaded.set(modId, table);
    }
    const handler = table[name];
    if (!handler) return { ok: false, error: `builtin-rpc-unknown:${name}` };
    try {
        return { ok: true, result: await handler(args) };
    } catch (error) {
        // 抛出来的句子就是给界面看的那一句（模组只显示这段文字），所以原样递过去。
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
};

/** 这个模组有没有渲染进程侧的处理表（诊断用）。 */
export const hasBuiltinRpc = (modId: string): boolean => modId in TABLES;
