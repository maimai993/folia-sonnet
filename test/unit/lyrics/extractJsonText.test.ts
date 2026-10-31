import { describe, expect, it } from 'vitest';
import { extractJsonText, sliceBalancedJson } from '@/services/lyricDirector/prompt';

// test/unit/lyrics/extractJsonText.test.ts
// 模型回复里夹说明文字、夹代码块、或写到一半被截断时，都要能取出（或明确取不出）那段 JSON。

describe('extractJsonText', () => {
    it('takes a bare object as it is', () => {
        expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
    });

    it('takes the object out of ```json fences with prose around them', () => {
        const raw = '好的，下面是结果：\n```json\n{"theme":{"name":"x"}}\n```\n希望有帮助。';
        expect(extractJsonText(raw)).toBe('{"theme":{"name":"x"}}');
    });

    it('takes the first balanced object when prose follows it', () => {
        const raw = '推荐模式：**tilt-shift**。{"decision":{"mode":"sonnet"}} 以上。{ 这是后面的说明 }';
        expect(extractJsonText(raw)).toBe('{"decision":{"mode":"sonnet"}}');
    });

    it('is not fooled by braces inside strings', () => {
        const raw = 'note {"lyric":"a } b","x":1} tail';
        expect(extractJsonText(raw)).toBe('{"lyric":"a } b","x":1}');
    });

    it('keeps a truncated object as far as it goes instead of swallowing the prose', () => {
        const raw = '推荐模式：**til';
        expect(extractJsonText(raw)).toBe('推荐模式：**til');
        expect(sliceBalancedJson('{"a":{' , 0)).toBeNull();
    });
});
