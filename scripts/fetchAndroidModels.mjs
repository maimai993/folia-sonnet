import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/fetchAndroidModels.mjs
// 把安卓原生推理要的两份 ONNX 权重放进 APK 的 assets/models/。
//
// 为什么要有这个脚本：assets/models/ 从来不在 git 里（.gitignore），而 Kotlin 侧的
// AutomixModels 只认识这两个文件名 —— 没有它们，智能动感（拍点）和分轨（鼓点/人声）
// 在真机上就是「模型装不上、效果永远不动」。桌面端的权重走 shared/modelManifest.json
// 的新格式（.bin + MNN/WebGPU），安卓这条原生路仍然读 ONNX，所以清单在这里另立一份。
//
// 与 build/fetchModels.mjs 同样：大小和 sha256 是判断「拿到的是不是模型」的唯一标准。
// 镜像上存在同名但截断/替换的文件时，宁可失败，也不要打一个「能装上、结果全是错的」APK。
//
// 用法：npm run models:android（cap:sync:android 会自动先跑）

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'android', 'app', 'src', 'main', 'assets', 'models');

/** 与 android/.../AutomixModels.kt 的 ENTRIES 一一对应。 */
/*
 * 2026-11 起只有两个：节拍（beat_this）和四轨分离（scnet）。
 *
 * htdemucs 已经整条链路删掉了（Kotlin 侧没有 Runner、Web 侧没有槽位），这里也必须一起删。
 * 留着它的后果不是「多一个文件」：assets/models/ 下的文件会原样打进 APK，
 * 那份 108MB 的旧权重会安安静静地躺在包里，谁也不报错，只是安装包大一倍。
 */
const MODELS = [
    {
        file: 'beat_this.onnx',
        bytes: 83077778,
        sha256: 'c5c1466e08abdb03fdeb50668a06f244b787d564c212490482231a9cfbe9ccbd',
        from: 'mirror',
    },
    {
        /*
         * 从 SCNet 官方权重（starrytong/SCNet, MIT）导出的 ONNX，int8 量化后 12.9MB。
         *
         * 它不在镜像上：导出要 torch + 量化校准，不是「下载一个文件」能得到的，
         * 所以这里只校验、不下载。缺失时直接报出来源，比悄悄去镜像取一个同名的
         * 别的文件安全 —— 分轨结果全错的 APK 比打不出来更难查。
         */
        file: 'scnet.int8.onnx',
        bytes: 12900277,
        sha256: '98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845',
        from: 'local',
    },
];

/*
 * 镜像顺序：先 hf-mirror（国内可达），再 huggingface 原站。
 *
 * 这两个文件在 models-v1 之后就不再是「当前版本」的权重了，但一直留在镜像上给旧版本用
 * （shared/modelManifest.json 的注释里写着），所以这里能取到。
 */
const MIRRORS = [
    'https://hf-mirror.com/HUAI4236/folia-models/resolve/main/{file}',
    'https://huggingface.co/HUAI4236/folia-models/resolve/main/{file}',
];

/** 首字节的等待上限；传输本身另有预算。 */
const RESPOND_TIMEOUT_MS = 30_000;
/** 190MB 在慢网上的上限。 */
const TRANSFER_TIMEOUT_MS = 20 * 60_000;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const verified = (buffer, model) => buffer.length === model.bytes && sha256(buffer) === model.sha256;

const alreadyThere = async (path, model) => {
    if (!existsSync(path)) return false;
    const info = await stat(path);
    if (info.size !== model.bytes) return false;
    return verified(await readFile(path), model);
};

const reason = (error) => error?.cause?.message || error?.message || String(error);

const ATTEMPTS = 3;

/** 单次取回；失败时抛。镜像偶发的连接超时不该让整次打包失败。 */
const fetchOnce = async (url, model) => {
    const controller = new AbortController();
    let deadline = setTimeout(() => controller.abort(new Error('no response')), RESPOND_TIMEOUT_MS);
    try {
        const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
        clearTimeout(deadline);
        deadline = setTimeout(() => controller.abort(new Error('transfer stalled')), TRANSFER_TIMEOUT_MS);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!verified(buffer, model)) {
            throw new Error(`${buffer.length} bytes, sha256 ${sha256(buffer).slice(0, 12)}`
                + ` (wanted ${model.bytes}, ${model.sha256.slice(0, 12)})`);
        }
        return buffer;
    } finally {
        clearTimeout(deadline);
    }
};

const download = async (url, model) => {
    let last;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        try {
            return await fetchOnce(url, model);
        } catch (error) {
            last = error;
            if (attempt < ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
    throw last;
};

const main = async () => {
    await mkdir(ASSETS, { recursive: true });
    for (const model of MODELS) {
        const target = join(ASSETS, model.file);
        if (await alreadyThere(target, model)) {
            console.log(`[android-models] ${model.file} already present and verified`);
            continue;
        }
        if (existsSync(target)) {
            const info = await stat(target);
            console.warn(`[android-models] ${model.file} 存在但校验不通过（${info.size} bytes），将重新获取`);
        }
        if (model.from === 'local') {
            throw new Error(
                `[android-models] 缺少 ${model.file}（${model.bytes} bytes, sha256 ${model.sha256.slice(0, 12)}）。`
                + ' 这份权重需要从 SCNet 官方 checkpoint 自行导出并做 int8 量化，镜像上没有。',
            );
        }
        console.log(`[android-models] fetching ${model.file} (${(model.bytes / 1e6).toFixed(0)}MB)`);
        const failures = [];
        let written = false;
        for (const template of MIRRORS) {
            const url = template.replace('{file}', model.file);
            try {
                const buffer = await download(url, model);
                // 先写 .part 再改名：中途被打断不会留下一个「大小刚好对」的残件。
                const part = `${target}.part`;
                await writeFile(part, buffer);
                await rename(part, target);
                console.log(`[android-models] ${model.file} verified and written, from ${new URL(url).host}`);
                written = true;
                break;
            } catch (error) {
                failures.push(`${new URL(url).host}: ${reason(error)}`);
            }
        }
        for (const failure of failures) console.warn(`[android-models]   skipped ${failure}`);
        if (!written) throw new Error(`[android-models] could not get a good copy of ${model.file}`);
    }
};

await main();
