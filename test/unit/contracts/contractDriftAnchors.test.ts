// test/unit/contracts/contractDriftAnchors.test.ts
// 契约文档的可校验部分：不能出现会漂移的代码行号，导航用的符号名必须真的存在（issue M33）。
// 行号写死在文档里，改动一行实现文档就指向了无关代码，而漂移本身没有任何门禁能发现；
// 所以文档只留「符号名」，由这里核对每个符号在当前源码里仍然存在。
//
// 覆盖面按文件逐个放行：同步服务契约已经清完，其余契约文档还带着历史行号引用，
// 清完一份就把文件名加进 CLEAN_DOCS，规则自然接管。

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../../ci/contracts/extract.ts';

const CONTRACT_DIR = path.join(repoRoot, 'docs/contracts');

/** 已清完行号引用、改用符号锚点的契约文档。 */
const CLEAN_DOCS = ['sync-server-api.md'];

/** 符号锚点只能落在这些目录里的实现文件上。 */
const SOURCE_DIRS = ['sync-server/src', 'src'];

const read = (file: string): string => fs.readFileSync(path.join(CONTRACT_DIR, file), 'utf8');

/** 形如 `app.ts:306-311`、`syncClient.ts:102`、`admin.ts:37-58` 的行号引用。 */
const LINE_REFERENCE = /[\w.-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs):\d/;

/**
 * 文档里用反引号包起来的 `文件名:符号名`。
 * 文件名以 .ts/.mts 结尾且必然带目录分隔，符号名是标识符（允许 `.成员`），
 * 所以 `omni.ts:79-80` 这种行号不会误判成符号。
 */
const SYMBOL_REFERENCE = /`((?:[\w.-]+\/)*[\w.-]+\.(?:ts|mts)):([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g;

/** 仓库里所有 .ts/.mts 实现文件，按「目录/文件名」建索引，用来判定契约里的引用能不能落到实现上。 */
const implementationFiles = (root: string): Set<string> => {
    const found = new Set<string>();
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const rel = dir + '/' + entry.name;
            if (entry.isDirectory()) walk(rel);
            else if (/\.m?ts$/.test(entry.name)) found.add(rel);
        }
    };
    for (const dir of SOURCE_DIRS) {
        if (fs.existsSync(path.join(root, dir))) walk(dir);
    }
    return found;
};

describe('契约文档不写会漂移的行号（issue M33）', () => {
    it.each(CLEAN_DOCS)('%s 里没有 `文件:行号` 形式的引用', (file) => {
        const offenders: string[] = [];
        read(file).split('\n').forEach((line, index) => {
            const match = LINE_REFERENCE.exec(line);
            if (match) offenders.push(`${file}:${index + 1} 引用了 ${match[0]}`);
        });
        expect(offenders, '行号会跟着实现漂移，改成符号名，例如 app.ts:bearerAuth').toEqual([]);
    });
});

describe('契约文档里的符号名指向真实存在的代码（issue M33）', () => {
    it.each(CLEAN_DOCS)('%s 提到的每个符号都找得到', (file) => {
        const root = repoRoot;
        const files = implementationFiles(root);
        const missing: string[] = [];
        for (const match of read(file).matchAll(SYMBOL_REFERENCE)) {
            const [, target, symbol] = match;
            const suffix = '/' + target;
            const candidates = [...files].filter(candidate => candidate.endsWith(suffix) || candidate === target);
            if (candidates.length === 0) {
                missing.push(`${file}: ${target} 不是源码里的实现文件（${SOURCE_DIRS.join(' / ')} 下找不到）`);
                continue;
            }
            const hit = candidates.some((candidate) => {
                const text = fs.readFileSync(path.join(root, candidate), 'utf8');
                // `foo.bar` 直接找全名；单段符号按整词找，避免 `api` 命中 `capital`。
                return symbol.includes('.') ? text.includes(symbol) : new RegExp(`\\b${symbol}\\b`).test(text);
            });
            if (!hit) missing.push(`${file}: ${candidates.join(', ')} 里没有 ${symbol}`);
        }
        expect(missing).toEqual([]);
    });

    it('同步服务契约给够了符号锚点', () => {
        // 防止「把行号删掉、也不给符号」这种假修：删了行号之后文档仍要能指到实现。
        const anchors = [...read('sync-server-api.md').matchAll(SYMBOL_REFERENCE)].length;
        expect(anchors).toBeGreaterThanOrEqual(20);
    });
});
