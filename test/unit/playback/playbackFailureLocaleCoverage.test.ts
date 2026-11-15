import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en';
import id from '@/i18n/locales/in';
import zh from '@/i18n/locales/zh-CN';
import {
    PLAYBACK_FAILURE_ACTION_LABEL_KEYS,
    PLAYBACK_FAILURE_MESSAGE_KEYS,
    PLAYBACK_RETRYING_MESSAGE_KEY,
    UNPLAYABLE_SKIP_PROMPT_KEY,
} from '@/services/playbackRecovery/playbackFailurePolicy';

// test/unit/playback/playbackFailureLocaleCoverage.test.ts
// 播放失败时用户看到的那几句话，三份语言文件里都得有：`PLAYBACK_FAILURE_POLICY` 的文案 key 由
// `MESSAGE_KEY_REGISTRY` 用 tsc 保证不漏成员，但「语言文件里到底写没写」只有这里能钉住。
// 少一条就是播放失败那一刻给人看 `status.songMembershipRequired` 这样的键名。
// 顺带钉参数名：`{{provider}}` 写错成别的，界面上会原样显示花括号。

const LOCALES: [string, Record<string, unknown>][] = [['zh-CN', zh], ['en', en], ['in', id]];

/** 「status.foo」这种点分 key 在一份语言文件里的原文；没有就是 undefined。 */
const textOf = (dictionary: Record<string, unknown>, key: string): string | undefined => {
    let node: unknown = dictionary;
    for (const part of key.split('.')) {
        if (typeof node !== 'object' || node === null) return undefined;
        node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : undefined;
};

/** 文案里的 {{name}} 参数名，排好序便于比较。 */
const placeholdersOf = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]!).sort();

const ALL_KEYS = [...PLAYBACK_FAILURE_MESSAGE_KEYS, PLAYBACK_RETRYING_MESSAGE_KEY, UNPLAYABLE_SKIP_PROMPT_KEY, ...PLAYBACK_FAILURE_ACTION_LABEL_KEYS];

describe('playback failure text coverage', () => {
    it('has a text for every key it can show, in every locale', () => {
        const missing = ALL_KEYS.flatMap(key => LOCALES
            .filter(([, dictionary]) => {
                const text = textOf(dictionary, key);
                return !text || text.trim() === '';
            })
            .map(([name]) => `${name} 缺 ${key}`));
        expect(missing).toEqual([]);
    });

    it('keeps the {{params}} of a text the same in every locale', () => {
        const [baseName, baseDictionary] = LOCALES[0]!;
        const mismatched = ALL_KEYS.flatMap((key) => {
            const base = placeholdersOf(textOf(baseDictionary, key) ?? '');
            return LOCALES.slice(1)
                .filter(([, dictionary]) => {
                    const other = placeholdersOf(textOf(dictionary, key) ?? '');
                    return other.join('|') !== base.join('|');
                })
                .map(([name, dictionary]) => `${key}: ${baseName} 用 [${base.join(', ')}]，${name} 用 [${placeholdersOf(textOf(dictionary, key) ?? '').join(', ')}]`);
        });
        expect(mismatched).toEqual([]);
    });
});
