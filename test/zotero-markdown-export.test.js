import test from 'node:test';
import assert from 'node:assert/strict';
import {
    markdownExportFileName,
    createZoteroMarkdownExport,
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

    assert.deepEqual(result, { cancelled: false, path: '/tmp/exported.md' });
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
