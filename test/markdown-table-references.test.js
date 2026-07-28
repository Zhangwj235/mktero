import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkdownTableReferences } from '../src/markdown/markdown-table-references.js';

test('maps a prose table reference to its uniquely captioned table', () => {
    const markdown = [
        '# Results',
        '',
        'Model performance is reported in Table 5.',
        '',
        'Table 5. Open-source model performance',
        '',
        '| Model | Accuracy |',
        '| --- | ---: |',
        '| LLaMA | 0.72 |',
    ].join('\n');

    const result = analyzeMarkdownTableReferences(markdown);

    assert.deepEqual(result.targets.map(target => ({
        id: target.id,
        label: target.label,
        caption: target.caption,
        kind: target.table.kind,
        source: target.table.source,
    })), [{
        id: 'table:5',
        label: 'Table 5.',
        caption: 'Table 5. Open-source model performance',
        kind: 'gfm',
        source: [
            '| Model | Accuracy |',
            '| --- | ---: |',
            '| LLaMA | 0.72 |',
        ].join('\n'),
    }]);
    assert.deepEqual(result.references.map(reference => ({
        text: markdown.slice(reference.from, reference.to),
        targetId: reference.targetId,
    })), [{
        text: 'Table 5',
        targetId: 'table:5',
    }]);
});

test('ignores table references inside code and existing links', () => {
    const markdown = [
        '# Results',
        '',
        '`Table 5` is an example token.',
        '',
        '```text',
        'Table 5',
        '```',
        '',
        '[Table 5](https://example.com) is already linked.',
        '',
        'The actual result is in Table 5.',
        '',
        'Table 5. Model performance',
        '',
        '| Model | Score |',
        '| --- | ---: |',
        '| LLaMA | 0.72 |',
    ].join('\n');

    const result = analyzeMarkdownTableReferences(markdown);

    assert.deepEqual(
        result.references.map(reference => (
            markdown.slice(reference.from, reference.to)
        )),
        ['Table 5']
    );
    assert.equal(
        result.references[0].from,
        markdown.indexOf('Table 5', markdown.indexOf('actual result'))
    );
});

test('does not resolve a table reference when captions reuse its identifier', () => {
    const markdown = [
        'See Table 5 for the result.',
        '',
        'Table 5. First result',
        '',
        '| A |',
        '| --- |',
        '| 1 |',
        '',
        'Table 5. Reused identifier',
        '',
        '| B |',
        '| --- |',
        '| 2 |',
    ].join('\n');

    const result = analyzeMarkdownTableReferences(markdown);

    assert.deepEqual(result.targets, []);
    assert.deepEqual(result.references, []);
});
