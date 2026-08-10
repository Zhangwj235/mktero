import test from 'node:test';
import assert from 'node:assert/strict';
import {
    openMarkdownRevisionSession,
} from '../src/core/markdown-revision-session.js';

const CACHE_KEY = 'a'.repeat(64);

function createMemoryStore() {
    let saved = null;
    return {
        async load(cacheKey) {
            assert.equal(cacheKey, CACHE_KEY);
            return saved ? structuredClone(saved) : null;
        },
        async save(cacheKey, revision) {
            assert.equal(cacheKey, CACHE_KEY);
            saved = structuredClone(revision);
        },
        async delete(cacheKey) {
            assert.equal(cacheKey, CACHE_KEY);
            saved = null;
        },
    };
}

function createBaseDocument() {
    const heading = '# Study';
    const paragraph = 'The study included 5O participants.';
    const conclusion = 'Conclusion.';
    const markdown = [heading, paragraph, conclusion].join('\n\n');
    const paragraphFrom = markdown.indexOf(paragraph);
    const conclusionFrom = markdown.indexOf(conclusion);
    return {
        itemID: 42,
        cacheKey: CACHE_KEY,
        markdown,
        sourceMap: [{
            type: 'title',
            markdownFrom: 0,
            markdownTo: heading.length,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 180] }],
        }, {
            type: 'text',
            markdownFrom: paragraphFrom,
            markdownTo: paragraphFrom + paragraph.length,
            locations: [{ pageIndex: 0, bbox: [100, 200, 900, 300] }],
            locationRanges: [{
                markdownFrom: paragraphFrom,
                markdownTo: paragraphFrom + paragraph.length,
                location: { pageIndex: 0, bbox: [100, 200, 900, 300] },
            }],
        }, {
            type: 'text',
            markdownFrom: conclusionFrom,
            markdownTo: conclusionFrom + conclusion.length,
            locations: [{ pageIndex: 1, bbox: [100, 100, 900, 180] }],
            locationRanges: [{
                markdownFrom: conclusionFrom,
                markdownTo: conclusionFrom + conclusion.length,
                location: { pageIndex: 1, bbox: [100, 100, 900, 180] },
            }],
        }],
        assets: [],
        assetBasePath: '',
        extractedPages: 2,
        totalPages: 2,
    };
}

test('commits a paragraph correction and downgrades only its source mapping', async () => {
    const store = createMemoryStore();
    const session = await openMarkdownRevisionSession({
        baseDocument: createBaseDocument(),
        store,
        now: () => 1_786_320_000_000,
    });
    const initial = session.snapshot();
    const paragraph = initial.editableBlocks.find(block => (
        block.originalMarkdown.includes('5O participants')
    ));

    const corrected = await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'The study included fifty participants.',
    });

    assert.equal(
        corrected.markdown,
        '# Study\n\nThe study included fifty participants.\n\nConclusion.'
    );
    assert.equal(corrected.correctionCount, 1);
    assert.deepEqual(corrected.correctedBlockIDs, [paragraph.id]);
    assert.equal(corrected.sourceMap[1].corrected, true);
    assert.equal('locationRanges' in corrected.sourceMap[1], false);
    assert.equal(corrected.sourceMap[2].corrected, undefined);
    assert.equal(
        corrected.sourceMap[2].markdownFrom,
        corrected.markdown.indexOf('Conclusion.')
    );
    assert.equal(
        corrected.sourceMap[2].locationRanges[0].markdownFrom,
        corrected.markdown.indexOf('Conclusion.')
    );
});

test('restores one correction and deletes the persisted revision when empty', async () => {
    const store = createMemoryStore();
    const baseDocument = createBaseDocument();
    const session = await openMarkdownRevisionSession({ baseDocument, store });
    const paragraph = session.snapshot().editableBlocks.find(block => (
        block.type === 'paragraph'
    ));
    await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'Corrected paragraph.',
    });

    const restored = await session.restore(paragraph.id);

    assert.equal(restored.markdown, baseDocument.markdown);
    assert.equal(restored.correctionCount, 0);
    const reopened = await openMarkdownRevisionSession({ baseDocument, store });
    assert.equal(reopened.snapshot().correctionCount, 0);
});

test('persists table cell corrections across sessions', async () => {
    const store = createMemoryStore();
    const markdown = [
        '# Results',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| Accuracy | 9O% |',
    ].join('\n');
    const baseDocument = {
        ...createBaseDocument(),
        markdown,
        sourceMap: [],
    };
    const first = await openMarkdownRevisionSession({ baseDocument, store });
    const table = first.snapshot().editableBlocks.find(block => (
        block.type === 'table'
    ));
    await first.commit({
        blockID: table.id,
        replacementMarkdown: [
            '| Metric | Value |',
            '| --- | --- |',
            '| Accuracy | 90% |',
        ].join('\n'),
    });

    const reopened = await openMarkdownRevisionSession({ baseDocument, store });

    assert.match(reopened.snapshot().markdown, /\| Accuracy \| 90% \|/);
    assert.equal(reopened.snapshot().correctionCount, 1);
});

test('rejects structural and unsafe replacements', async () => {
    const session = await openMarkdownRevisionSession({
        baseDocument: createBaseDocument(),
        store: createMemoryStore(),
    });
    const paragraph = session.snapshot().editableBlocks.find(block => (
        block.type === 'paragraph'
    ));

    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: 'First paragraph.\n\nSecond paragraph.',
        }),
        /one editable block/i
    );
    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: '![Remote](https://example.com/image.png)',
        }),
        /images cannot be added/i
    );
    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: 'Text <img src=x onerror=alert(1)>',
        }),
        /raw HTML cannot be added/i
    );
    assert.equal(session.snapshot().correctionCount, 0);
});

test('restores all corrections without changing the immutable base', async () => {
    const store = createMemoryStore();
    const baseDocument = createBaseDocument();
    const session = await openMarkdownRevisionSession({ baseDocument, store });
    const [heading, paragraph] = session.snapshot().editableBlocks;
    await session.commit({
        blockID: heading.id,
        replacementMarkdown: '## Corrected study',
    });
    await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'Corrected paragraph.',
    });

    const restored = await session.restoreAll();

    assert.equal(restored.markdown, baseDocument.markdown);
    assert.equal(restored.correctionCount, 0);
});

test('does not expose formula blocks for correction', async () => {
    const baseDocument = {
        ...createBaseDocument(),
        markdown: 'The value is $E = mc^2$.\n\nPlain recognition text.',
        sourceMap: [],
    };
    const session = await openMarkdownRevisionSession({
        baseDocument,
        store: createMemoryStore(),
    });

    assert.deepEqual(
        session.snapshot().editableBlocks.map(block => block.markdown),
        ['Plain recognition text.']
    );
});
