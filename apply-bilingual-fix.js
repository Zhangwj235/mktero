import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ============================================================================
// PR #95 bilingual fix — applies all source and test changes on top of 8fa41f3
// ============================================================================
// Run this from the project root (the directory containing package.json).
// Prerequisite: git reset --hard 8fa41f3  (undo the test-hack commit first)

const errors = [];

function patch(file, oldStr, newStr) {
    let src = readFileSync(file, 'utf8');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const oldJoined = oldStr.replace(/\n/g, eol);
    const newJoined = newStr.replace(/\n/g, eol);
    if (!src.includes(oldJoined)) {
        errors.push(`FAIL [${file}]: pattern not found`);
        return;
    }
    if (src.indexOf(oldJoined) !== src.lastIndexOf(oldJoined)) {
        errors.push(`FAIL [${file}]: pattern matched more than once`);
        return;
    }
    src = src.replace(oldJoined, newJoined);
    writeFileSync(file, src, 'utf8');
    console.log(`OK  [${file}]: patched`);
}

function writeNew(file, content) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    console.log(`OK  [${file}]: created`);
}

// ---------------------------------------------------------------------------
// 1. New file: src/markdown/export-markdown-selector.js
// ---------------------------------------------------------------------------
writeNew('src/markdown/export-markdown-selector.js', [
    '/**',
    ' * Selects the Markdown source to export based on the current translation view.',
    ' *',
    ' * The export must follow the active reading view so that users export what',
    ' * they actually see: the original text, the bilingual comparison, or the pure',
    ' * translation. This is a pure synchronous function because it only inspects',
    ' * model fields and never performs I/O.',
    ' *',
    ' * @param {object|null} model - The presentation model.',
    ' * @returns {string} The Markdown string to export (may be empty).',
    ' */',
    'export function selectExportMarkdown(model) {',
    '    if (!model) return \'\';',
    '    const view = model.translationView;',
    '    if (view === \'translated\'',
    '        && typeof model.translatedMarkdown === \'string\'',
    '        && model.translatedMarkdown) {',
    '        return model.translatedMarkdown;',
    '    }',
    '    if (view === \'compare\'',
    '        && typeof model.comparisonMarkdown === \'string\'',
    '        && model.comparisonMarkdown) {',
    '        return model.comparisonMarkdown;',
    '    }',
    '    return model.markdown || \'\';',
    '}',
    '',
].join('\n'));

// ---------------------------------------------------------------------------
// 2. src/bootstrap.js — add import, remove two async functions
// ---------------------------------------------------------------------------
patch('src/bootstrap.js',
    `import {
    createEvidenceSnippet,
    formatEvidenceMarkdown,
} from './markdown/markdown-evidence.js';`,
    `import {
    createEvidenceSnippet,
    formatEvidenceMarkdown,
} from './markdown/markdown-evidence.js';
import { selectExportMarkdown } from './markdown/export-markdown-selector.js';`);

patch('src/bootstrap.js',
    `async function selectExportMarkdown(model) {
    if (!model) return '';
    const view = model.translationView;
    if (view === 'translated'
        && typeof model.translatedMarkdown === 'string'
        && model.translatedMarkdown) {
        return model.translatedMarkdown;
    }
    if (view === 'compare'
        && typeof model.comparisonMarkdown === 'string'
        && model.comparisonMarkdown) {
        return model.comparisonMarkdown;
    }
    return model.markdown || '';
}

async function selectExportSourceMap(model) {
    if (!model) return [];
    const view = model.translationView;
    if (view === 'compare'
        && Array.isArray(model.sourceMap)
        && Array.isArray(model.translationBlockRanges)
        && model.sourceMap.length > 0
        && typeof mapSourceMapToComparison === 'function') {
        return mapSourceMapToComparison(
            model.sourceMap,
            model.translationBlockRanges
        );
    }
    return model.sourceMap || [];
}

async function exportMarkdownForModel(model, { ownerWindow } = {}) {`,
    `async function exportMarkdownForModel(model, { ownerWindow } = {}) {`);

// ---------------------------------------------------------------------------
// 3. src/ui/markdown-window.js — restore coordinate mapping
// ---------------------------------------------------------------------------
patch('src/ui/markdown-window.js',
    `    copySourcedMarkdown(target) {
        if (typeof this.model.onCopySourcedMarkdown !== 'function') {
            throw new Error('Sourced Markdown copy is unavailable');
        }
        return this.model.onCopySourcedMarkdown(target);
    }`,
    `    copySourcedMarkdown(target) {
        if (typeof this.model.onCopySourcedMarkdown !== 'function') {
            throw new Error('Sourced Markdown copy is unavailable');
        }
        const sourceTarget = this.model.translationView === 'compare'
            ? mapComparisonTargetToSource(
                target,
                this.model.translationBlockRanges
            )
            : target;
        if (!sourceTarget) {
            throw new Error('A reliable PDF source is unavailable');
        }
        return this.model.onCopySourcedMarkdown(sourceTarget);
    }`);

// ---------------------------------------------------------------------------
// 4. package.json — add new module to check script
// ---------------------------------------------------------------------------
patch('package.json',
    `node --check src/markdown/markdown-evidence.js && node --check src/markdown/markdown-export.js`,
    `node --check src/markdown/markdown-evidence.js && node --check src/markdown/export-markdown-selector.js && node --check src/markdown/markdown-export.js`);

// ---------------------------------------------------------------------------
// 5. test/markdown-window.test.js — add imports + two real call-chain tests
// ---------------------------------------------------------------------------
patch('test/markdown-window.test.js',
    `import { createMarkdownTabView } from '../src/ui/markdown-window.js';`,
    `import { createMarkdownTabView } from '../src/ui/markdown-window.js';
import { createEvidenceSnippet } from '../src/markdown/markdown-evidence.js';
import { selectExportMarkdown } from '../src/markdown/export-markdown-selector.js';`);

patch('test/markdown-window.test.js',
    `    }), /source/i);
    view.destroy();
});

test('forwards code copy requests to the current tab model', async () => {`,
    `    }), /source/i);
    view.destroy();
});

test('maps compare-view copy targets to source coordinates so evidence resolves through the real snippet chain', async () => {
    let editorOptions;
    let resolvedSnippet = null;
    const sourceMap = [{
        type: 'text',
        markdownFrom: 9,
        markdownTo: 28,
        locations: [{ pageIndex: 2, bbox: [100, 200, 900, 300] }],
    }];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\\n\\nOriginal paragraph.',
        sourceMap,
        translationStatus: 'ready',
        translationView: 'compare',
        translatedMarkdown: '# 论文\\n\\n译文段落。',
        comparisonMarkdown: [
            '# Paper',
            '',
            '# 论文',
            '',
            'Original paragraph.',
            '',
            '译文段落。',
        ].join('\\n'),
        translationBlockRanges: [{
            id: 'translation-1-9-28-paragraph',
            sourceFrom: 9,
            sourceTo: 28,
            translatedFrom: 6,
            translatedTo: 11,
            comparisonSourceFrom: 15,
            comparisonSourceTo: 34,
            comparisonTranslationFrom: 36,
            comparisonTranslationTo: 41,
        }],
        onCopySourcedMarkdown: target => {
            resolvedSnippet = createEvidenceSnippet({
                markdown: model.markdown,
                sourceMap: model.sourceMap,
                target,
            });
            return resolvedSnippet;
        },
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                setCorrectionState() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await editorOptions.copySourcedMarkdown({
        kind: 'selection',
        text: 'Original',
        ranges: [{ from: 15, to: 23 }],
    });

    assert.ok(resolvedSnippet, 'the real evidence chain was invoked');
    assert.deepEqual(resolvedSnippet.pageIndexes, [2]);

    assert.throws(() => createEvidenceSnippet({
        markdown: model.markdown,
        sourceMap: model.sourceMap,
        target: {
            kind: 'selection',
            text: 'Original',
            ranges: [{ from: 15, to: 23 }],
        },
    }), {
        message: /source|Markdown range/i,
    });

    view.destroy();
});

test('exports the Markdown matching the active translation view through the real selector', async () => {
    let editorOptions;
    let exportedMarkdown = null;
    const comparisonMarkdown = [
        '# Paper',
        '',
        '# 论文',
        '',
        'Original paragraph.',
        '',
        '译文段落。',
    ].join('\\n');
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\\n\\nOriginal paragraph.',
        translatedMarkdown: '# 论文\\n\\n译文段落。',
        comparisonMarkdown,
        translationStatus: 'ready',
        translationView: 'compare',
        onExportMarkdown: () => {
            exportedMarkdown = selectExportMarkdown(model);
            return { status: 'success' };
        },
    });
    const { view, shadow } = createView(model);
    const toggle = shadow.querySelector('#mktero-document-actions');
    const exportButton = shadow.querySelector('#mktero-export-markdown');

    toggle.click();
    exportButton.click();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(exportedMarkdown, comparisonMarkdown);

    view.destroy();
});

test('forwards code copy requests to the current tab model', async () => {`);

// ---------------------------------------------------------------------------
// 6. New file: test/export-markdown-selector.test.js
// ---------------------------------------------------------------------------
writeNew('test/export-markdown-selector.test.js', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "",
    "import { selectExportMarkdown } from '../src/markdown/export-markdown-selector.js';",
    "",
    "test('returns the original Markdown when no translation view is active', () => {",
    "    const model = {",
    "        markdown: '# Paper\\n\\nOriginal paragraph.',",
    "        translationView: 'original',",
    "    };",
    "    assert.equal(selectExportMarkdown(model), '# Paper\\n\\nOriginal paragraph.');",
    "});",
    "",
    "test('returns the original Markdown when the translation view is missing', () => {",
    "    const model = { markdown: '# Paper' };",
    "    assert.equal(selectExportMarkdown(model), '# Paper');",
    "});",
    "",
    "test('returns the translated Markdown in the translated reading view', () => {",
    "    const model = {",
    "        markdown: '# Paper\\n\\nOriginal paragraph.',",
    "        translatedMarkdown: '# 论文\\n\\n译文段落。',",
    "        translationView: 'translated',",
    "    };",
    "    assert.equal(selectExportMarkdown(model), '# 论文\\n\\n译文段落。');",
    "});",
    "",
    "test('returns the comparison Markdown in the bilingual comparison view', () => {",
    "    const comparison = [",
    "        '# Paper',",
    "        '',",
    "        '# 论文',",
    "        '',",
    "        'Original paragraph.',",
    "        '',",
    "        '译文段落。',",
    "    ].join('\\n');",
    "    const model = {",
    "        markdown: '# Paper\\n\\nOriginal paragraph.',",
    "        translatedMarkdown: '# 论文\\n\\n译文段落。',",
    "        comparisonMarkdown: comparison,",
    "        translationView: 'compare',",
    "    };",
    "    assert.equal(selectExportMarkdown(model), comparison);",
    "});",
    "",
    "test('falls back to the original Markdown when the translated view lacks text', () => {",
    "    const model = {",
    "        markdown: '# Paper',",
    "        translatedMarkdown: '',",
    "        translationView: 'translated',",
    "    };",
    "    assert.equal(selectExportMarkdown(model), '# Paper');",
    "});",
    "",
    "test('falls back to the original Markdown when the comparison view lacks text', () => {",
    "    const model = {",
    "        markdown: '# Paper',",
    "        comparisonMarkdown: '',",
    "        translationView: 'compare',",
    "    };",
    "    assert.equal(selectExportMarkdown(model), '# Paper');",
    "});",
    "",
    "test('returns an empty string for a missing model', () => {",
    "    assert.equal(selectExportMarkdown(null), '');",
    "    assert.equal(selectExportMarkdown(undefined), '');",
    "});",
    "",
    "test('returns a string, never a Promise, so exporters receive a real value', () => {",
    "    const model = {",
    "        markdown: '# Paper',",
    "        translatedMarkdown: '# 论文',",
    "        translationView: 'translated',",
    "    };",
    "    const result = selectExportMarkdown(model);",
    "    assert.equal(typeof result, 'string');",
    "    assert.ok(!(result instanceof Promise));",
    "});",
    "",
].join('\n'));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (errors.length > 0) {
    console.error('\n=== ERRORS ===');
    for (const e of errors) console.error(e);
    console.error('\nMake sure you ran: git reset --hard 8fa41f3');
    process.exit(1);
}
console.log('\n=== ALL CHANGES APPLIED ===');
console.log('Next: npm run check && npm test');
