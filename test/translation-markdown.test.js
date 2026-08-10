import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBilingualMarkdown } from '../src/translation/translation-markdown.js';

function completedSegment({ from, to, text }) {
    return { id: `segment-${from}`, from, to, text, status: 'complete' };
}

test('returns the original Markdown when there is no translation', () => {
    const source = '# Title\n\nEnglish paragraph.';
    assert.equal(buildBilingualMarkdown(source, undefined), source);
    assert.equal(buildBilingualMarkdown(source, null), source);
    assert.equal(
        buildBilingualMarkdown(source, { segments: [] }),
        source
    );
    assert.equal(
        buildBilingualMarkdown(source, { segments: undefined }),
        source
    );
});

test('appends the Chinese translation after each English block', () => {
    const source = '# Introduction\n\nThe model estimates demand.\n';
    const translation = {
        segments: [
            completedSegment({ from: 0, to: 14, text: '# 引言' }),
            completedSegment({ from: 16, to: 43, text: '该模型估计了需求。' }),
        ],
    };
    const result = buildBilingualMarkdown(source, translation);
    assert.match(result, /^# Introduction\n\n# 引言/);
    assert.match(result, /该模型估计了需求。\s*$/);
    assert.ok(result.includes('The model estimates demand.'));
    assert.ok(result.includes('该模型估计了需求。'));
});

test('keeps untranslated regions as the English original', () => {
    const source = [
        '# Title',
        '',
        'A translated paragraph.',
        '',
        '```js',
        'const x = 1;',
        '```',
        '',
        'Another English only paragraph.',
        '',
    ].join('\n');
    // Only the first paragraph is translated; code fence and last paragraph stay.
    const translation = {
        segments: [
            completedSegment({ from: 9, to: 33, text: '一段已翻译的段落。' }),
        ],
    };
    const result = buildBilingualMarkdown(source, translation);
    assert.ok(result.includes('```js'));
    assert.ok(result.includes('const x = 1;'));
    assert.ok(result.includes('Another English only paragraph.'));
    assert.ok(result.includes('一段已翻译的段落。'));
});

test('skips segments that are not complete and ignores overlaps', () => {
    const source = 'Alpha. Beta. Gamma.';
    const translation = {
        segments: [
            { id: 'a', from: 0, to: 6, text: '阿尔法。', status: 'failed' },
            completedSegment({ from: 7, to: 12, text: '贝塔。' }),
            // Overlaps the previous completed segment on purpose.
            completedSegment({ from: 10, to: 17, text: '重叠。' }),
        ],
    };
    const result = buildBilingualMarkdown(source, translation);
    assert.ok(result.includes('阿尔法。') === false);
    assert.ok(result.includes('贝塔。'));
    assert.ok(result.includes('重叠。') === false);
    assert.ok(result.includes('Gamma.'));
});

test('tolerates out-of-range offsets without throwing', () => {
    const source = 'Short.';
    const translation = {
        segments: [
            completedSegment({ from: 0, to: 100, text: '太长。' }),
        ],
    };
    const result = buildBilingualMarkdown(source, translation);
    assert.equal(result, source);
});
