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

import {
    CitationGraphCache,
    createCitationCacheKey,
} from '../src/cache/citation-graph-cache.js';

test('changes cache keys when source identifiers change', async () => {
    const base = { libraryID: 1, key: 'ABC', doi: '10.1000/first', arxivID: '' };

    assert.notEqual(
        await createCitationCacheKey(base),
        await createCitationCacheKey({ ...base, doi: '10.1000/second' })
    );
    assert.notEqual(
        await createCitationCacheKey(base),
        await createCitationCacheKey({ ...base, libraryID: 2 })
    );
    assert.equal((await createCitationCacheKey(base)).length, 64);
});

test('persists records and reports stale positive and negative entries', async t => {
    let timestamp = 1_000;
    const fixture = await createCacheFixture(t, {
        now: () => timestamp,
        positiveFreshMs: 1_000,
        negativeFreshMs: 100,
    });
    const positiveKey = 'a'.repeat(64);
    const negativeKey = 'b'.repeat(64);
    await fixture.cache.put(positiveKey, record('fetched', timestamp));
    await fixture.cache.put(negativeKey, record('unindexed', timestamp));

    timestamp = 1_200;

    assert.equal((await fixture.cache.get(positiveKey)).stale, false);
    assert.equal((await fixture.cache.get(negativeKey)).stale, true);
    timestamp = 2_100;
    assert.equal((await fixture.cache.get(positiveKey)).stale, true);
});

test('removes corrupt and expired citation records', async t => {
    let timestamp = 1_000;
    const fixture = await createCacheFixture(t, {
        now: () => timestamp,
        maxAgeMs: 1_000,
    });
    const corruptKey = 'c'.repeat(64);
    const expiredKey = 'd'.repeat(64);
    const wrongSchemaKey = '4'.repeat(64);
    await fixture.cache.put(corruptKey, record('fetched', timestamp));
    await fixture.cache.put(expiredKey, record('fetched', timestamp));
    await writeFile(path.join(fixture.rootPath, `${corruptKey}.json`), '{bad');
    await writeFile(
        path.join(fixture.rootPath, `${wrongSchemaKey}.json`),
        JSON.stringify({ schemaVersion: 99, cacheKey: wrongSchemaKey })
    );

    assert.equal(await fixture.cache.get(corruptKey), null);
    assert.equal(await fixture.cache.get(wrongSchemaKey), null);
    timestamp = 2_100;
    assert.equal(await fixture.cache.get(expiredKey), null);
    assert.deepEqual(await fixture.cache.getStats(), { entries: 0, sizeBytes: 0 });
});

test('evicts least recently used entries and rejects oversized records', async t => {
    let timestamp = 1_000;
    const fixture = await createCacheFixture(t, {
        now: () => timestamp,
        maxEntries: 1,
        maxEntryBytes: 1_024,
    });
    const firstKey = 'e'.repeat(64);
    const secondKey = 'f'.repeat(64);
    await fixture.cache.put(firstKey, record('fetched', timestamp));
    timestamp = 2_000;
    await fixture.cache.put(secondKey, record('fetched', timestamp));

    assert.equal(await fixture.cache.get(firstKey), null);
    assert.ok(await fixture.cache.get(secondKey));
    await assert.rejects(
        () => fixture.cache.put('1'.repeat(64), {
            ...record('fetched', timestamp),
            references: Array.from({ length: 10 }, (_, index) => ({
                paperID: `large${index}`,
                title: 'x'.repeat(100),
                year: 2024,
                doi: '',
                arxivID: '',
                authors: [],
            })),
        }),
        /size limit/
    );
});

test('removes interrupted writes and clears all citation cache usage', async t => {
    const fixture = await createCacheFixture(t);
    const key = '2'.repeat(64);
    await fixture.cache.put(key, record('fetched', 1_000));
    await writeFile(path.join(fixture.rootPath, `${'3'.repeat(64)}.json.tmp`), 'tmp');

    await fixture.cache.prune();

    assert.deepEqual(await readdir(fixture.rootPath), [`${key}.json`]);
    assert.equal((await fixture.cache.getStats()).entries, 1);
    await fixture.cache.clear();
    assert.deepEqual(await fixture.cache.getStats(), { entries: 0, sizeBytes: 0 });
});

test('serializes operations after a failed atomic write', async t => {
    const ioUtils = createNodeIOUtils();
    const writeUTF8 = ioUtils.writeUTF8;
    const temporaryPaths = [];
    let failNextWrite = true;
    ioUtils.writeUTF8 = async (filePath, data, options = {}) => {
        temporaryPaths.push(options.tmpPath);
        if (failNextWrite) {
            failNextWrite = false;
            throw new Error('write failed');
        }
        return writeUTF8(filePath, data, options);
    };
    const fixture = await createCacheFixture(t, { ioUtils });
    const failedKey = '5'.repeat(64);
    const successKey = '6'.repeat(64);

    await assert.rejects(
        () => fixture.cache.put(failedKey, record('fetched', 1_000)),
        /write failed/
    );
    await fixture.cache.put(successKey, record('fetched', 2_000));

    assert.equal(await fixture.cache.get(failedKey), null);
    assert.ok(await fixture.cache.get(successKey));
    assert.ok(temporaryPaths.every(filePath => filePath?.endsWith('.json.tmp')));
});

function record(status, fetchedAt) {
    return {
        status,
        paperID: status === 'fetched' ? 's2-source' : '',
        references: status === 'fetched' ? [{
            paperID: 's2-target',
            title: 'Target',
            year: 2024,
            doi: '10.1000/target',
            arxivID: '',
            authors: ['Author'],
        }] : [],
        truncated: false,
        fetchedAt,
    };
}

async function createCacheFixture(t, options = {}) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-citations-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const {
        ioUtils = createNodeIOUtils(),
        ...cacheOptions
    } = options;
    return {
        rootPath,
        cache: new CitationGraphCache({
            rootPath,
            ioUtils,
            pathUtils: {
                join: path.join,
                filename: path.basename,
                parent: path.dirname,
            },
            ...cacheOptions,
        }),
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
            const details = await stat(filePath);
            return {
                size: details.size,
                type: details.isDirectory() ? 'directory' : 'regular',
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
