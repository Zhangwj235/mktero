import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkdownOutline } from '../src/markdown/markdown-outline.js';

test('extracts visible Markdown headings and their source offsets', () => {
    const markdown = [
        '# Overview',
        '',
        '## Methods *and* [data](https://example.com)',
        '',
        '```markdown',
        '# Not a heading',
        '```',
        '',
        'Results',
        '-------',
    ].join('\n');

    assert.deepEqual(extractMarkdownOutline(markdown), [
        { level: 1, text: 'Overview', offset: markdown.indexOf('# Overview') },
        {
            level: 2,
            text: 'Methods and data',
            offset: markdown.indexOf('## Methods'),
        },
        { level: 2, text: 'Results', offset: markdown.indexOf('Results') },
    ]);
});

test('returns an empty outline when the document has no headings', () => {
    assert.deepEqual(extractMarkdownOutline('Paragraph only.'), []);
});

test('preserves visible angle-bracket text in outline labels', () => {
    const markdown = [
        '# Visit <https://example.com>',
        '',
        '## 2 < 3 and 4 > 1',
        '',
        '### <span>Wrapped</span>',
        '',
        '#### FTP <ftp://example.com/a>',
        '',
        '##### Left<br>Right',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => heading.text),
        [
            'Visit https://example.com',
            '2 < 3 and 4 > 1',
            'Wrapped',
            'FTP ftp://example.com/a',
            'Left Right',
        ]
    );
});
