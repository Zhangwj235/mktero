import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkdownFigureReferences } from '../src/markdown/markdown-figure-references.js';

test('maps a prose figure reference to a uniquely captioned image', () => {
    const markdown = [
        '# Results',
        '',
        'The study flow is summarized in Figure 1.',
        '',
        '![Figure 1. PRISMA flowchart](images/flow.png)',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.targets.map(target => ({
        id: target.id,
        label: target.label,
        caption: target.caption,
        source: target.figure.source,
    })), [{
        id: 'figure:1',
        label: 'Figure 1.',
        caption: 'Figure 1. PRISMA flowchart',
        source: '![Figure 1. PRISMA flowchart](images/flow.png)',
    }]);
    assert.deepEqual(result.references.map(reference => ({
        text: markdown.slice(reference.from, reference.to),
        targetId: reference.targetId,
    })), [{
        text: 'Figure 1',
        targetId: 'figure:1',
    }]);
});

test('maps Fig. references to every panel in a shared-caption figure', () => {
    const markdown = [
        'The ablation is shown in Fig. S2.',
        '',
        '![](images/panel-a.png)',
        '',
        '![](images/panel-b.png)  ',
        'FIG. S2: Ablation results by cohort.',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.equal(result.targets.length, 1);
    assert.equal(result.targets[0].id, 'figure:s2');
    assert.equal(result.targets[0].caption, 'FIG. S2: Ablation results by cohort.');
    assert.equal(
        result.targets[0].figure.source.match(/!\[\]/g)?.length,
        2
    );
    assert.deepEqual(result.references.map(reference => (
        markdown.slice(reference.from, reference.to)
    )), ['Fig. S2']);
});

test('ignores figure references in code and links and rejects duplicate labels', () => {
    const markdown = [
        '`Figure 3` is an example token.',
        '',
        '[Figure 3](https://example.com) is already linked.',
        '',
        'The actual result is in Figure 3.',
        '',
        '![Figure 3. First result](images/first.png)',
        '',
        '![Fig. 3: Reused identifier](images/second.png)',
    ].join('\n');

    const result = analyzeMarkdownFigureReferences(markdown);

    assert.deepEqual(result.targets, []);
    assert.deepEqual(result.references, []);
});
