import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
    createZoteroMarkdownExporter,
} from '../src/platform/zotero-markdown-exporter.js';

const pathUtils = {
    filename: path.posix.basename,
    join: path.posix.join,
    parent: path.posix.dirname,
};

test('cancels a Markdown export without writing files', async () => {
    const writes = [];
    const picker = createFilePicker({ result: 1 });
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => picker,
        ioUtils: createIOUtils(writes),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: { name: 'zotero-window' },
        title: 'Paper',
        markdown: '# Paper',
        assets: [],
    });

    assert.deepEqual(result, { status: 'cancelled' });
    assert.deepEqual(writes, []);
    assert.equal(picker.defaultString, 'Paper.md');
    assert.equal(picker.defaultExtension, 'md');
    assert.deepEqual(picker.initialized, {
        ownerWindow: { name: 'zotero-window' },
        title: 'viewer.exportMarkdownDialogTitle',
        mode: 1,
    });
});

test('localizes the default Markdown export file name', async () => {
    const picker = createFilePicker({ result: 1 });
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => picker,
        ioUtils: createIOUtils([]),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key === 'viewer.exportMarkdownDefaultFileName'
            ? '文档'
            : key,
    });

    await exporter.export({
        ownerWindow: {},
        title: '',
        markdown: '',
        assets: [],
    });

    assert.equal(picker.defaultString, '文档.md');
});

test('exports Markdown after writing its images into a sibling directory', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({ result: 0 }),
        ioUtils: createIOUtils(writes),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '![Figure](images/figure.png)',
        assetBasePath: 'result',
        assets: [{
            path: 'result/images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
    });

    assert.deepEqual(result, {
        status: 'exported',
        path: '/exports/Paper.md',
        assetDirectoryPath: '/exports/Paper.assets',
        assetCount: 1,
    });
    assert.deepEqual(writes, [
        {
            type: 'directory',
            path: '/exports/Paper.assets',
            options: { ignoreExisting: false },
        },
        {
            type: 'directory',
            path: '/exports/Paper.assets/images',
            options: { ignoreExisting: true },
        },
        {
            type: 'binary',
            path: '/exports/Paper.assets/images/figure.png',
            data: new Uint8Array([1, 2, 3]),
        },
        {
            type: 'text',
            path: '/exports/Paper.md',
            data: '![Figure](Paper.assets/images/figure.png)',
            options: {
                tmpPath: '/exports/Paper.md.mktero-request-id.tmp',
            },
        },
    ]);
});

test('adds the Markdown extension when the file picker omits it', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({
            result: 0,
            file: '/exports/Paper',
        }),
        ioUtils: createIOUtils(writes),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '# Paper',
        assets: [],
    });

    assert.equal(result.path, '/exports/Paper.md');
    assert.equal(writes.at(-1).path, '/exports/Paper.md');
});

test('does not overwrite an unconfirmed Markdown path after adding its extension', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({
            result: 0,
            file: '/exports/Paper',
        }),
        ioUtils: createIOUtils(writes, {
            existingPaths: ['/exports/Paper.md'],
        }),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    await assert.rejects(() => exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '# Paper',
        assets: [],
    }), /already exists/);
    assert.deepEqual(writes, []);
});

test('uses a new asset directory without overwriting an existing one', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({ result: 0 }),
        ioUtils: createIOUtils(writes, {
            existingPaths: ['/exports/Paper.assets'],
        }),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '![Figure](images/figure.png)',
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    });

    assert.equal(result.assetDirectoryPath, '/exports/Paper.assets-2');
    assert.equal(
        writes.at(-1).data,
        '![Figure](Paper.assets-2/images/figure.png)'
    );
});

test('retries when an asset directory is created during export', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({ result: 0 }),
        ioUtils: createIOUtils(writes, {
            raceDirectoryPath: '/exports/Paper.assets',
        }),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '![Figure](images/figure.png)',
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    });

    assert.equal(result.assetDirectoryPath, '/exports/Paper.assets-2');
    assert.equal(
        writes.some(write => (
            write.type === 'remove'
            && write.path === '/exports/Paper.assets'
        )),
        false
    );
});

test('removes new export files when an image write fails', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({ result: 0 }),
        ioUtils: createIOUtils(writes, { failBinary: true }),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    await assert.rejects(() => exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '![Figure](images/figure.png)',
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    }), /image write failed/);

    assert.equal(writes.some(write => write.type === 'text'), false);
    assert.deepEqual(
        writes.filter(write => write.type === 'remove').map(write => write.path),
        [
            '/exports/Paper.md.mktero-request-id.tmp',
            '/exports/Paper.assets',
        ]
    );
});

function createFilePicker({ result, file = '/exports/Paper.md' }) {
    return {
        modeSave: 1,
        returnCancel: 1,
        defaultString: '',
        defaultExtension: '',
        file,
        init(ownerWindow, title, mode) {
            this.initialized = { ownerWindow, title, mode };
        },
        appendFilter() {},
        async show() {
            return result;
        },
    };
}

function createIOUtils(writes, {
    existingPaths = [],
    failBinary = false,
    raceDirectoryPath = '',
} = {}) {
    const existing = new Set(existingPaths);
    let raced = false;
    return {
        async exists(filePath) {
            return existing.has(filePath);
        },
        async makeDirectory(filePath, options) {
            writes.push({ type: 'directory', path: filePath, options });
            if (!raced
                && filePath === raceDirectoryPath
                && options?.ignoreExisting === false) {
                raced = true;
                existing.add(filePath);
                throw new Error('directory already exists');
            }
        },
        async write(filePath, data) {
            writes.push({ type: 'binary', path: filePath, data });
            if (failBinary) throw new Error('image write failed');
        },
        async writeUTF8(filePath, data, options) {
            writes.push({ type: 'text', path: filePath, data, options });
        },
        async remove(filePath) {
            writes.push({ type: 'remove', path: filePath });
        },
    };
}
