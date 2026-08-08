import test from 'node:test';
import assert from 'node:assert/strict';
import {
    highlightCodeBlock,
    normalizeCodeBlockLanguage,
    shouldHighlightCodeBlock,
} from '../src/markdown/code-highlighting.js';

test('normalizes common fenced-code language aliases', () => {
    assert.equal(normalizeCodeBlockLanguage('js'), 'javascript');
    assert.equal(normalizeCodeBlockLanguage('shellscript'), 'shell');
    assert.equal(normalizeCodeBlockLanguage('C++'), 'cpp');
    assert.equal(normalizeCodeBlockLanguage('language-PY'), 'python');
    assert.equal(normalizeCodeBlockLanguage(''), 'text');
});

test('applies highlighting only within supported code budgets', () => {
    assert.equal(shouldHighlightCodeBlock('const x = 1;', 'javascript'), true);
    assert.equal(shouldHighlightCodeBlock('plain text', 'text'), false);
    assert.equal(shouldHighlightCodeBlock('unknown', 'not-a-language'), false);
    assert.equal(shouldHighlightCodeBlock('x'.repeat(50_001), 'javascript'), false);
    assert.equal(
        shouldHighlightCodeBlock(
            Array.from({ length: 5_001 }, () => 'x').join('\n'),
            'javascript'
        ),
        false
    );
});
test('returns Shiki tokens while preserving code text and line breaks', async () => {
    const code = [
        'const answer = 42;',
        'console.log(answer);',
        '',
    ].join('\n');
    const result = await highlightCodeBlock({
        code,
        language: 'js',
        theme: 'light',
    });

    assert.equal(result.language, 'javascript');
    assert.equal(result.theme, 'light');
    assert.equal(
        result.lines
            .map(line => line.map(token => token.content).join(''))
            .join('\n'),
        code
    );
    assert.ok(result.lines.flat().some(token => token.color));
    assert.equal(
        await highlightCodeBlock({
            code: 'plain text',
            language: 'text',
            theme: 'light',
        }),
        null
    );
});
