import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
import { TranslationCache } from '../src/cache/translation-cache.js';

test('persists translations and reports their local cache usage', async t => {
    const fixture = await createCacheFixture(t);
    const key = 'a'.repeat(64);
    const translation = createTranslation('缓存译文');

    await fixture.cache.put(key, translation);

    assert.deepEqual(await fixture.cache.get(key), translation);
    const statistics = await fixture.cache.getStats();
    assert.equal(statistics.entries, 1);
    assert.ok(statistics.sizeBytes > 0);
    await fixture.cache.clear();
    assert.deepEqual(await fixture.cache.getStats(), {
        entries: 0,
        sizeBytes: 0,
    });
});

test('removes corrupt and expired translation entries', async t => {
    let timestamp = 1_000;
    const fixture = await createCacheFixture(t, {
        now: () => timestamp,
        maxAgeMs: 1_000,
    });
    const corruptKey = 'b'.repeat(64);
    const expiredKey = 'c'.repeat(64);
    await fixture.cache.put(corruptKey, createTranslation('corrupt'));
    await fixture.cache.put(expiredKey, createTranslation('expired'));
    await writeFile(
        path.join(fixture.rootPath, `${corruptKey}.json`),
        '{invalid'
    );

    assert.equal(await fixture.cache.get(corruptKey), null);
    timestamp = 3_000;
    assert.equal(await fixture.cache.get(expiredKey), null);
    assert.deepEqual(await fixture.cache.getStats(), {
        entries: 0,
        sizeBytes: 0,
    });
});

test('prunes the least recently used translation at the entry limit', async t => {
    let timestamp = 1_000;
    const fixture = await createCacheFixture(t, {
        now: () => timestamp,
        maxEntries: 1,
    });
    const firstKey = 'd'.repeat(64);
    const secondKey = 'e'.repeat(64);
    await fixture.cache.put(firstKey, createTranslation('first'));
    timestamp = 2_000;
    await fixture.cache.put(secondKey, createTranslation('second'));

    assert.equal(await fixture.cache.get(firstKey), null);
    assert.equal((await fixture.cache.get(secondKey)).text, 'second');
});

test('rejects oversized translation entries before writing them', async t => {
    const fixture = await createCacheFixture(t, { maxEntryBytes: 128 });

    await assert.rejects(
        fixture.cache.put(
            'f'.repeat(64),
            createTranslation('x'.repeat(256))
        ),
        /size limit/
    );
});

test('removes interrupted atomic-write files while pruning', async t => {
    const fixture = await createCacheFixture(t);
    const tmpPath = path.join(
        fixture.rootPath,
        `${'1'.repeat(64)}.json.tmp`
    );
    await writeFile(tmpPath, 'interrupted write');

    await fixture.cache.prune();

    assert.deepEqual(await readdir(fixture.rootPath), []);
});

async function createCacheFixture(t, options = {}) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-ai-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    return {
        rootPath,
        cache: new TranslationCache({
            rootPath,
            ioUtils: createNodeIOUtils(),
            pathUtils: {
                join: path.join,
                filename: path.basename,
                parent: path.dirname,
            },
            ...options,
        }),
    };
}

function createTranslation(text) {
    return {
        text,
        model: 'example-chat',
        targetLanguage: 'zh-CN',
        promptVersion: 'mktero-translation-v1',
    };
}

function createNodeIOUtils() {
    return {
        async exists(filePath) {
            try {
                await stat(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        async makeDirectory(filePath, { ignoreExisting } = {}) {
            await mkdir(filePath, { recursive: Boolean(ignoreExisting) });
        },
        readUTF8: filePath => readFile(filePath, 'utf8'),
        async writeUTF8(filePath, data, { tmpPath } = {}) {
            if (!tmpPath) return writeFile(filePath, data, 'utf8');
            await writeFile(tmpPath, data, 'utf8');
            await rename(tmpPath, filePath);
        },
        async stat(filePath) {
            const fileStat = await stat(filePath);
            return {
                size: fileStat.size,
                type: fileStat.isDirectory() ? 'directory' : 'regular',
            };
        },
        async getChildren(filePath) {
            return (await readdir(filePath)).map(name => path.join(filePath, name));
        },
        async remove(filePath, { recursive, ignoreAbsent } = {}) {
            await rm(filePath, {
                recursive: Boolean(recursive),
                force: Boolean(ignoreAbsent),
            });
        },
    };
}
