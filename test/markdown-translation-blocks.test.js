import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assembleTranslatedMarkdown,
    collectMarkdownTranslationBlocks,
    createComparisonMarkdown,
    validateTranslatedBlock,
} from '../src/markdown/markdown-translation-blocks.js';

test('collects translatable top-level Markdown blocks in document order', () => {
    const markdown = [
        '# Paper',
        '',
        'A paragraph with *emphasis* and $x = 1$.',
        '',
        '- First item',
        '- Second item',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| Alpha | 1 |',
    ].join('\n');

    const blocks = collectMarkdownTranslationBlocks(markdown);

    assert.deepEqual(blocks.map(block => ({
        type: block.type,
        markdown: block.markdown,
        translatable: block.translatable,
    })), [{
        type: 'heading',
        markdown: '# Paper',
        translatable: true,
    }, {
        type: 'paragraph',
        markdown: 'A paragraph with *emphasis* and $x = 1$.',
        translatable: true,
    }, {
        type: 'list',
        markdown: '- First item\n- Second item',
        translatable: true,
    }, {
        type: 'table',
        markdown: '| Name | Value |\n| --- | --- |\n| Alpha | 1 |',
        translatable: true,
    }]);
    assert.equal(new Set(blocks.map(block => block.id)).size, blocks.length);
});

test('translates Setext headings while preserving their heading level', () => {
    const markdown = 'Paper title\n===========';
    const [block] = collectMarkdownTranslationBlocks(markdown);

    assert.equal(block.type, 'heading');
    assert.equal(block.translatable, true);
    assert.equal(
        assembleTranslatedMarkdown(markdown, [block], [{
            id: block.id,
            markdown: '论文标题\n========',
        }]),
        '论文标题\n========'
    );
    assert.throws(
        () => assembleTranslatedMarkdown(markdown, [block], [{
            id: block.id,
            markdown: '## 论文标题',
        }]),
        /structure/i
    );
});

test('preserves structural and unsafe blocks instead of sending them for translation', () => {
    const markdown = [
        '![Figure](images/figure.png)',
        '',
        '```js',
        'alert("do not translate");',
        '```',
        '',
        '$$E = mc^2$$',
        '',
        '<script>alert(1)</script>',
        '',
        '[paper]: https://example.com/paper',
    ].join('\n');

    const blocks = collectMarkdownTranslationBlocks(markdown);

    assert.equal(blocks.length, 5);
    assert.deepEqual(blocks.map(block => block.translatable), [
        false,
        false,
        false,
        false,
        false,
    ]);
});

test('translates text around protected Markdown without exposing protected content', () => {
    const markdown = [
        'Read `model.fit()`, keep $E = mc^2$, then see',
        '![Figure](images/figure.png) and <kbd>Enter</kbd>.',
    ].join(' ');
    const [block] = collectMarkdownTranslationBlocks(markdown);

    assert.equal(block.translatable, true);
    assert.doesNotMatch(block.requestMarkdown, /model\.fit|mc\^2|figure\.png|kbd/);
    assert.equal(block.protectedFragments.length, 5);

    const providerOutput = block.requestMarkdown
        .replace('Read', '阅读')
        .replace('keep', '保留')
        .replace('then see', '然后查看')
        .replace('and', '并按下')
        .replaceAll(', ', '，');
    assert.equal(validateTranslatedBlock(block, providerOutput), [
        '阅读 `model.fit()`，保留 $E = mc^2$，然后查看',
        '![Figure](images/figure.png) 并按下 <kbd>Enter</kbd>.',
    ].join(' '));
});

test('protects display math nested inside lists and blockquotes', () => {
    const markdown = [
        '- Explain the equation:',
        '',
        '  $$',
        '  E = mc^2',
        '  $$',
        '',
        '> Compare the result:',
        '>',
        '> \\[',
        '> a + b = c',
        '> \\]',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translatable = blocks.filter(block => block.translatable);

    assert.equal(translatable.length, 2);
    assert.deepEqual(
        translatable.map(block => block.protectedFragments.length),
        [1, 1]
    );
    assert.doesNotMatch(
        translatable.map(block => block.requestMarkdown).join('\n'),
        /mc\^2|a \+ b/
    );

    const translations = translatable.map(block => ({
        id: block.id,
        markdown: block.requestMarkdown
            .replace('Explain the equation', '解释这个公式')
            .replace('Compare the result', '比较结果'),
    }));
    assert.equal(
        assembleTranslatedMarkdown(markdown, blocks, translations),
        markdown
            .replace('Explain the equation', '解释这个公式')
            .replace('Compare the result', '比较结果')
    );
});

test('does not translate blocks containing only protected Markdown', () => {
    const blocks = collectMarkdownTranslationBlocks([
        '`model.fit()`',
        '',
        '![Figure](images/figure.png)',
        '',
        '$E = mc^2$',
        '',
        'https://example.com/paper',
    ].join('\n'));

    assert.deepEqual(blocks.map(block => block.translatable), [
        false,
        false,
        false,
        false,
    ]);
});

test('translates link text without exposing or changing its destination', () => {
    const [block] = collectMarkdownTranslationBlocks(
        'Read [the paper](https://example.com/paper).'
    );
    const translated = block.requestMarkdown
        .replace('Read', '阅读')
        .replace('the paper', '这篇论文');

    assert.doesNotMatch(block.requestMarkdown, /https:\/\//);
    assert.equal(
        validateTranslatedBlock(block, translated),
        '阅读 [这篇论文](https://example.com/paper).'
    );
});

test('rejects missing, duplicated, or fabricated protected placeholders', () => {
    const [block] = collectMarkdownTranslationBlocks(
        'Run `model.fit()` and inspect ![Figure](figure.png).'
    );
    const [first] = block.protectedFragments;

    assert.throws(
        () => validateTranslatedBlock(
            block,
            block.requestMarkdown.replace(first.placeholder, '')
        ),
        /protected/i
    );
    assert.throws(
        () => validateTranslatedBlock(
            block,
            `${block.requestMarkdown} ${first.placeholder}`
        ),
        /protected/i
    );
    assert.throws(
        () => validateTranslatedBlock(
            block,
            `${block.requestMarkdown} MKTEROPROTECTED999PLACEHOLDER`
        ),
        /protected/i
    );
    assert.throws(
        () => validateTranslatedBlock(
            block,
            block.requestMarkdown.replace(
                first.placeholder,
                `**${first.placeholder}**`
            )
        ),
        /protected/i
    );
});

test('assembles a complete translated article while preserving document spacing', () => {
    const markdown = '# Paper\n\nOriginal paragraph.\n\n![Figure](figure.png)\n';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = [{
        id: blocks[0].id,
        markdown: '# 论文',
    }, {
        id: blocks[1].id,
        markdown: '译文段落。',
    }];

    assert.equal(
        assembleTranslatedMarkdown(markdown, blocks, translations),
        '# 论文\n\n译文段落。\n\n![Figure](figure.png)\n'
    );
});

test('creates block-level comparison Markdown with source above translation', () => {
    const markdown = '# Paper\n\nOriginal paragraph.\n\n![Figure](figure.png)';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = [{
        id: blocks[0].id,
        markdown: '# 论文',
    }, {
        id: blocks[1].id,
        markdown: '译文第一句。译文第二句。',
    }];

    assert.equal(createComparisonMarkdown(markdown, blocks, translations), [
        '# Paper',
        '',
        '> # 论文',
        '',
        'Original paragraph.',
        '',
        '> 译文第一句。译文第二句。',
        '',
        '![Figure](figure.png)',
    ].join('\n'));
});

test('rejects incomplete or mismatched translation sets', () => {
    const markdown = '# Paper\n\nParagraph.';
    const blocks = collectMarkdownTranslationBlocks(markdown);

    assert.throws(
        () => assembleTranslatedMarkdown(markdown, blocks, []),
        /missing/i
    );
    assert.throws(
        () => assembleTranslatedMarkdown(markdown, blocks, [{
            id: blocks[0].id,
            markdown: 'Not a heading.',
        }, {
            id: blocks[1].id,
            markdown: '段落。',
        }]),
        /structure/i
    );
});
