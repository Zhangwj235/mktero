import test from 'node:test';
import assert from 'node:assert/strict';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    openMarkdownRevisionSession,
} from '../src/core/markdown-revision-session.js';
import {
    ZoteroMarkdownRevisionStore,
} from '../src/platform/zotero-markdown-revision-store.js';

const CACHE_KEY = 'a'.repeat(64);

test('restores corrected Markdown and assets across revision store instances', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-revisions-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname },
        now: () => 1_786_320_000_000,
    };
    const baseDocument = {
        itemID: 42,
        cacheKey: CACHE_KEY,
        markdown: '# Paper\n\nThe result was 9O%.',
        sourceMap: [],
        assets: [{
            path: 'paper/images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        assetBasePath: 'paper',
        extractedPages: 1,
        totalPages: 1,
    };
    const first = await openMarkdownRevisionSession({
        baseDocument,
        store: new ZoteroMarkdownRevisionStore(options),
    });
    const paragraph = first.snapshot().editableBlocks.find(block => (
        block.type === 'paragraph'
    ));
    await first.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'The result was 90%.',
    });

    const reopened = await openMarkdownRevisionSession({
        baseDocument: { ...baseDocument, markdown: '# Ignored fresh result' },
        store: new ZoteroMarkdownRevisionStore(options),
    });

    const snapshot = reopened.snapshot();
    assert.equal(snapshot.markdown, '# Paper\n\nThe result was 90%.');
    assert.deepEqual([...snapshot.assets[0].data], [1, 2, 3]);
    assert.equal(snapshot.correctionCount, 1);
});

test('deletes a revision without touching a sibling cache directory', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-revisions-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cacheMarker = path.join(path.dirname(rootPath), 'mktero-cache-marker');
    await writeFile(cacheMarker, 'keep');
    t.after(() => rm(cacheMarker, { force: true }));
    const store = new ZoteroMarkdownRevisionStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname },
    });
    const baseDocument = {
        itemID: 42,
        cacheKey: CACHE_KEY,
        markdown: '# Paper\n\nOriginal.',
        sourceMap: [],
        assets: [],
    };
    const session = await openMarkdownRevisionSession({ baseDocument, store });
    const paragraph = session.snapshot().editableBlocks.find(block => (
        block.type === 'paragraph'
    ));
    await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'Corrected.',
    });

    await session.restoreAll();

    assert.equal(await store.load(CACHE_KEY), null);
    assert.equal(await readFile(cacheMarker, 'utf8'), 'keep');
});

test('reports corrupt revision metadata without deleting user files', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-revisions-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
    await mkdir(entryPath, { recursive: true });
    const metadataPath = path.join(entryPath, 'metadata.json');
    await writeFile(metadataPath, '{invalid');
    const store = new ZoteroMarkdownRevisionStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname },
    });

    await assert.rejects(() => store.load(CACHE_KEY), /invalid revision metadata/i);
    assert.equal(await readFile(metadataPath, 'utf8'), '{invalid');
});

test('rejects an individual revision image above the existing image budget', async () => {
    const writes = [];
    const store = new ZoteroMarkdownRevisionStore({
        rootPath: '/profile/mktero-revisions/v1',
        ioUtils: createMemoryIOUtils(writes),
        pathUtils: { join: path.join, parent: path.dirname },
    });
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1);

    await assert.rejects(() => store.save(CACHE_KEY, createRevisionWithAssets([{
        path: 'images/oversized.png',
        mimeType: 'image/png',
        data: oversized,
    }])), /assets exceed their size limit/i);
    assert.deepEqual(writes, []);
});

test('rejects aggregate revision images above the existing archive budget', async () => {
    const writes = [];
    const store = new ZoteroMarkdownRevisionStore({
        rootPath: '/profile/mktero-revisions/v1',
        ioUtils: createMemoryIOUtils(writes),
        pathUtils: { join: path.join, parent: path.dirname },
    });
    const sharedData = new Uint8Array(25 * 1024 * 1024);
    const assets = Array.from({ length: 7 }, (_, index) => ({
        path: `images/${index}.png`,
        mimeType: 'image/png',
        data: sharedData,
    }));

    await assert.rejects(
        () => store.save(CACHE_KEY, createRevisionWithAssets(assets)),
        /assets exceed their size limit/i
    );
    assert.deepEqual(writes, []);
});

function createRevisionWithAssets(assets) {
    return {
        schemaVersion: 1,
        base: {
            itemID: 42,
            cacheKey: CACHE_KEY,
            markdown: 'Original.',
            sourceMap: [],
            assets,
        },
        blocks: [],
        corrections: [{
            blockID: 'block-0',
            originalMarkdown: 'Original.',
            replacementMarkdown: 'Corrected.',
        }],
    };
}

function createMemoryIOUtils(writes) {
    return {
        exists: async () => false,
        makeDirectory: async () => {},
        write: async filePath => { writes.push(filePath); },
        writeUTF8: async filePath => { writes.push(filePath); },
    };
}

function createNodeIOUtils() {
    return {
        async exists(filePath) {
            try {
                await access(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        makeDirectory: (filePath, options = {}) => mkdir(filePath, {
            recursive: options.ignoreExisting !== false,
        }),
        read: async filePath => new Uint8Array(await readFile(filePath)),
        readUTF8: filePath => readFile(filePath, 'utf8'),
        getChildren: async filePath => (await readdir(filePath))
            .map(name => path.join(filePath, name)),
        stat: async filePath => {
            const value = await stat(filePath);
            return {
                type: value.isDirectory() ? 'directory' : 'regular',
                size: value.size,
            };
        },
        remove: (filePath, options = {}) => rm(filePath, {
            recursive: options.recursive,
            force: options.ignoreAbsent,
        }),
        async write(filePath, data, options = {}) {
            await atomicWrite(filePath, data, options.tmpPath);
        },
        async writeUTF8(filePath, data, options = {}) {
            await atomicWrite(filePath, data, options.tmpPath);
        },
    };
}

async function atomicWrite(filePath, data, temporaryPath) {
    if (!temporaryPath) {
        await writeFile(filePath, data);
        return;
    }
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, filePath);
}
