import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMistralResult } from '../src/mistral/mistral-result.js';

function page(overrides = {}) {
    return {
        index: 0,
        markdown: 'A sufficiently long paragraph for mapping.',
        dimensions: { width: 1000, height: 1000 },
        ...overrides,
    };
}

test('orders pages, joins Markdown, decodes images, and normalizes block bboxes', () => {
    const result = normalizeMistralResult({
        pages: [
            page({
                index: 1,
                markdown: 'Second page with enough text for mapping.',
                dimensions: { width: 1000, height: 2000 },
                blocks: [{
                    type: 'text',
                    content: 'Second page with enough text for mapping.',
                    bbox: [100, 200, 900, 400],
                }],
            }),
            page({
                markdown: '# First page\n\n![Figure](img-0.png)',
                images: [{
                    id: 'img-0.png',
                    image_base64: 'data:image/png;base64,AQID',
                }],
                blocks: [{
                    type: 'image',
                    content: 'img-0.png',
                    bbox: [10, 20, 300, 400],
                }],
            }),
        ],
        usage_info: { pages_processed: 4 },
    });

    assert.equal(
        result.markdown,
        '# First page\n\n![Figure](img-0.png)\n\n'
            + 'Second page with enough text for mapping.'
    );
    assert.equal(result.extractedPages, 2);
    assert.equal(result.totalPages, 4);
    assert.deepEqual(result.assets.map(asset => ({
        path: asset.path,
        mimeType: asset.mimeType,
        data: [...asset.data],
    })), [{ path: 'img-0.png', mimeType: 'image/png', data: [1, 2, 3] }]);
    assert.deepEqual(result.contentList, [
        {
            type: 'image',
            pageIndex: 0,
            bbox: [10, 20, 300, 400],
            assetPath: 'img-0.png',
        },
        {
            type: 'text',
            pageIndex: 1,
            bbox: [100, 100, 900, 200],
            text: 'Second page with enough text for mapping.',
        },
    ]);
    assert.equal(result.sourceMap.length, 2);
    assert.deepEqual(result.sourceMap.map(entry => entry.type), ['image', 'text']);
});

test('rewrites data and remote image destinations to local or empty paths', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                '![one](https://example.com/figure.png)',
                '![two](data:image/png;base64,AQID)',
                '![three](img%2Ftwo.png)',
            ].join('\n\n'),
            images: [{
                id: 'img/two.png',
                image_base64: 'data:image/png;base64,AQID',
            }],
        })],
    });
    assert.equal(result.markdown, [
        '![one]()',
        '![two](img/two.png)',
        '![three](img/two.png)',
    ].join('\n\n'));
});

test('skips optional malformed blocks and keeps source locations bounded', () => {
    const result = normalizeMistralResult({
        pages: [page({
            blocks: [
                null,
                { type: 'unknown', bbox: [0, 0, 1, 1] },
                { type: 'text', content: 'invalid dimensions', bbox: [0, 0, 0, 0] },
                { type: 'text', content: 'A sufficiently long paragraph for mapping.', bbox: [0, 0, 900, 900] },
            ],
        })],
        usage_info: { pages_processed: 'not-a-number' },
    }, { maxSourceLocations: 1 });
    assert.equal(result.contentList.length, 1);
    assert.equal(result.extractedPages, 1);
    assert.equal(result.totalPages, 1);
    assert.ok(result.warnings.length >= 3);
});

test('rejects malformed pages, images, Markdown, and resource limits', () => {
    assert.throws(
        () => normalizeMistralResult({ pages: [{ index: 0, markdown: 'x' }, { index: 0, markdown: 'y' }] }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
    );
    assert.throws(
        () => normalizeMistralResult({ pages: [page({ markdown: ' ', images: [{ id: '../x.png', image_base64: 'AQID' }] })] }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
    );
    assert.throws(
        () => normalizeMistralResult({ pages: [page({ images: [{ id: 'x.png', image_base64: 'not-base64' }] })] }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
    );
    assert.throws(
        () => normalizeMistralResult({ pages: [page()] }, { maxMarkdownBytes: 1 }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
    );
});

test('supports object pixel boxes and table/equation block text', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                '| A | B |',
                '| - | - |',
                '| 1 | 2 |',
                '',
                '$$x^2$$',
            ].join('\n'),
            blocks: [
                {
                    type: 'table',
                    markdown: '| A | B |\n| - | - |\n| 1 | 2 |',
                    bbox: { x: 100, y: 100, width: 800, height: 300 },
                },
                {
                    type: 'equation',
                    latex: '$$x^2$$',
                    bbox: {
                        top_left_x: 100,
                        top_left_y: 500,
                        bottom_right_x: 900,
                        bottom_right_y: 800,
                    },
                },
            ],
        })],
    });
    assert.deepEqual(result.contentList.map(block => ({
        type: block.type,
        bbox: block.bbox,
        text: block.text,
    })), [
        { type: 'table', bbox: [100, 100, 900, 400], text: '| A | B |\n| - | - |\n| 1 | 2 |' },
        { type: 'equation', bbox: [100, 500, 900, 800], text: '$$x^2$$' },
    ]);
});
