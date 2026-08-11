import test from 'node:test';
import assert from 'node:assert/strict';
import {
    markdownExportFileName,
    createZoteroMarkdownExport,
    exportMarkdownWithAssets,
} from '../src/platform/zotero-markdown-export.js';

test('markdownExportFileName removes invalid file name characters', () => {
    assert.equal(
        markdownExportFileName('Paper: Title / Sub? * <bad> | "q"'),
        'Paper Title Sub bad q.md'
    );
});

test('markdownExportFileName strips control characters and trims dots', () => {
    assert.equal(markdownExportFileName('\u0007Note\u007f'), 'Note.md');
    assert.equal(markdownExportFileName('...hidden...'), 'hidden.md');
    assert.equal(markdownExportFileName(' trailing. '), 'trailing.md');
});

test('markdownExportFileName enforces the length limit and falls back to a default', () => {
    const name = markdownExportFileName('a'.repeat(200));
    assert.ok(name.endsWith('.md'));
    assert.ok(name.length <= 123);
    assert.equal(markdownExportFileName(''), 'document.md');
    assert.equal(markdownExportFileName(null), 'document.md');
});

function createPicker(overrides = {}) {
    const picker = {
        _returnCode: 1,
        _file: { path: '/tmp/exported.md' },
        init: () => {},
        appendFilter: () => {},
        defaultExtension: '',
        defaultString: '',
        open: callback => callback(picker._returnCode),
        get file() {
            return picker._file;
        },
        ...overrides,
    };
    return picker;
}

function createComponents(picker) {
    return {
        classes: {
            '@mozilla.org/filepicker;1': {
                createInstance: () => picker,
            },
        },
        interfaces: {
            nsIFilePicker: {
                modeSave: 1,
                returnCancel: 0,
                returnOK: 1,
                returnReplace: 2,
            },
        },
    };
}

test('save writes Markdown to the chosen path and reports success', async () => {
    const picker = createPicker();
    const components = createComponents(picker);
    const written = [];
    const io = { writeUTF8: (path, data) => written.push([path, data]) };
    const exporter = createZoteroMarkdownExport({ components, io });

    const result = await exporter.save({
        markdown: '# Title\n\nBody',
        suggestedName: 'paper.md',
        window: {},
        title: 'paper.md',
    });

    assert.deepEqual(result, {
        cancelled: false,
        path: '/tmp/exported.md',
        assetDir: null,
        exportedAssets: 0,
    });
    assert.deepEqual(written, [['/tmp/exported.md', '# Title\n\nBody']]);
    assert.equal(picker.defaultString, 'paper.md');
    assert.equal(picker.defaultExtension, 'md');
});

test('save reports cancellation when the picker is dismissed', async () => {
    const picker = createPicker({ _returnCode: 0 });
    const components = createComponents(picker);
    const written = [];
    const io = { writeUTF8: () => written.push(true) };
    const exporter = createZoteroMarkdownExport({ components, io });

    const result = await exporter.save({
        markdown: '# Title',
        suggestedName: 'paper.md',
        window: {},
        title: 'paper.md',
    });

    assert.deepEqual(result, { cancelled: true, path: null });
    assert.equal(written.length, 0);
});

test('save falls back to a sanitized default name without suggestedName', async () => {
    const picker = createPicker();
    const components = createComponents(picker);
    const io = { writeUTF8: () => {} };
    const exporter = createZoteroMarkdownExport({ components, io });

    await exporter.save({ markdown: '# x', window: {}, title: 'Untitled: Draft' });

    assert.equal(picker.defaultString, 'Untitled Draft.md');
});

test('save rejects empty Markdown content', async () => {
    const exporter = createZoteroMarkdownExport({
        components: createComponents(createPicker()),
        io: { writeUTF8: () => {} },
    });
    await assert.rejects(
        () => exporter.save({ markdown: '', suggestedName: 'x.md', window: {}, title: 'x.md' }),
        /export/i
    );
    await assert.rejects(
        () => exporter.save({ markdown: '   ', suggestedName: 'x.md', window: {}, title: 'x.md' }),
        /export/i
    );
});

test('save rejects when the file picker or storage is unavailable', async () => {
    const missingPicker = createZoteroMarkdownExport({
        components: { classes: {}, interfaces: {} },
        io: { writeUTF8: () => {} },
    });
    await assert.rejects(
        () => missingPicker.save({ markdown: '# x', suggestedName: 'x.md', window: {}, title: 'x.md' }),
        /picker/i
    );

    const missingIo = createZoteroMarkdownExport({
        components: createComponents(createPicker()),
        io: {},
    });
    await assert.rejects(
        () => missingIo.save({ markdown: '# x', suggestedName: 'x.md', window: {}, title: 'x.md' }),
        /storage/i
    );
});

function createPathUtils() {
    return {
        join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
        parent: path => {
            const normalized = String(path).replace(/\\/g, '/');
            const index = normalized.lastIndexOf('/');
            return index > 0 ? normalized.slice(0, index) : '.';
        },
    };
}

function createAssetIo() {
    const written = [];
    return {
        written,
        writeUTF8: (path, data) => written.push(['utf8', path, data]),
        write: (path, data) => written.push(['bin', path, data]),
        makeDirectory: () => {},
    };
}

const JPEG_BYTES = new Uint8Array(
    [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]
);
const PNG_BYTES = new Uint8Array(
    [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]
);

test('save exports images into an assets directory and rewrites links', async () => {
    const picker = createPicker({ _file: { path: '/tmp/paper.md' } });
    const components = createComponents(picker);
    const io = createAssetIo();
    const pathUtils = createPathUtils();
    const exporter = createZoteroMarkdownExport({ components, io, pathUtils });

    const markdown = [
        '# Title',
        '',
        '![Figure 1](images/fig1.jpg)',
        '',
        '![Figure 2](images/fig2.png)',
        '',
    ].join('\n');

    const result = await exporter.save({
        markdown,
        suggestedName: 'paper.md',
        window: {},
        title: 'paper.md',
        assetBasePath: '',
        assets: [
            { path: 'images/fig1.jpg', mimeType: 'image/jpeg', data: JPEG_BYTES },
            { path: 'images/fig2.png', mimeType: 'image/png', data: PNG_BYTES },
        ],
    });

    assert.equal(result.cancelled, false);
    assert.equal(result.assetDir, '/tmp/assets');
    assert.equal(result.exportedAssets, 2);

    const mdWrite = io.written.find(w => w[0] === 'utf8' && w[1] === '/tmp/paper.md');
    assert.ok(mdWrite, 'Markdown was written');
    assert.match(mdWrite[2], /!\[Figure 1\]\(assets\/fig1\.jpg\)/);
    assert.match(mdWrite[2], /!\[Figure 2\]\(assets\/fig2\.png\)/);

    const fig1 = io.written.find(w => w[0] === 'bin' && w[1] === '/tmp/assets/fig1.jpg');
    const fig2 = io.written.find(w => w[0] === 'bin' && w[1] === '/tmp/assets/fig2.png');
    assert.ok(fig1, 'JPEG written with .jpg extension');
    assert.ok(fig2, 'PNG written with .png extension');
    assert.deepEqual([...fig1[2]], [...JPEG_BYTES]);
    assert.deepEqual([...fig2[2]], [...PNG_BYTES]);
});

test('save keeps text-only export behavior when no assets are supplied', async () => {
    const picker = createPicker({ _file: { path: '/tmp/paper.md' } });
    const components = createComponents(picker);
    const io = createAssetIo();
    const exporter = createZoteroMarkdownExport({ components, io });

    const result = await exporter.save({
        markdown: '# Only text',
        suggestedName: 'paper.md',
        window: {},
        title: 'paper.md',
    });

    assert.equal(result.assetDir, null);
    assert.equal(result.exportedAssets, 0);
    assert.deepEqual(
        io.written.filter(w => w[0] === 'utf8'),
        [['utf8', '/tmp/paper.md', '# Only text']]
    );
});

test('exportMarkdownWithAssets resolves links through assetBasePath', async () => {
    const io = createAssetIo();
    const pathUtils = createPathUtils();
    const markdown = '![x](images/x.jpg)';
    const { markdown: rewritten, files } = await exportMarkdownWithAssets({
        io,
        pathUtils,
        markdownPath: '/tmp/paper.md',
        markdown,
        assetBasePath: 'output',
        assets: [
            { path: 'output/images/x.jpg', mimeType: 'image/jpeg', data: JPEG_BYTES },
        ],
    });

    assert.equal(files.length, 1);
    assert.equal(files[0].fileName, 'x.jpg');
    assert.equal(rewritten, '![x](assets/x.jpg)');
});

test('exportMarkdownWithAssets derives the extension from magic bytes', async () => {
    const io = createAssetIo();
    const pathUtils = createPathUtils();
    const { files } = await exportMarkdownWithAssets({
        io,
        pathUtils,
        markdownPath: '/tmp/paper.md',
        markdown: '',
        assets: [
            // Mislabeled as png, but the bytes are actually JPEG.
            { path: 'img/binned', mimeType: 'image/png', data: JPEG_BYTES },
            { path: 'img/real.png', mimeType: 'image/png', data: PNG_BYTES },
        ],
    });

    const names = files.map(file => file.fileName).sort();
    assert.deepEqual(names, ['binned.jpg', 'real.png']);
});

test('exportMarkdownWithAssets disambiguates colliding base names', async () => {
    const io = createAssetIo();
    const pathUtils = createPathUtils();
    const { files, markdown } = await exportMarkdownWithAssets({
        io,
        pathUtils,
        markdownPath: '/tmp/paper.md',
        markdown: '![a](images/a.jpg)\n![b](figures/a.jpg)',
        assets: [
            { path: 'images/a.jpg', mimeType: 'image/jpeg', data: JPEG_BYTES },
            { path: 'figures/a.jpg', mimeType: 'image/jpeg', data: JPEG_BYTES },
        ],
    });

    const names = files.map(file => file.fileName).sort();
    assert.deepEqual(names, ['a-2.jpg', 'a.jpg']);
    assert.match(markdown, /\(assets\/a\.jpg\)/);
    assert.match(markdown, /\(assets\/a-2\.jpg\)/);
});

