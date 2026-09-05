import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'test/markdown-window.test.js';
let src = readFileSync(FILE, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';
const fixes = [];

// --- Fix 1: expected copied ranges 15->23  ==>  9->17 (mapped source coords) ---
const old1 = [
    "    assert.deepEqual(copied, [{",
    "        kind: 'selection',",
    "        text: 'Original',",
    "        ranges: [{ from: 15, to: 23 }],",
    "    }]);",
].join(eol);
const new1 = [
    "    assert.deepEqual(copied, [{",
    "        kind: 'selection',",
    "        text: 'Original',",
    "        ranges: [{ from: 9, to: 17 }],",
    "    }]);",
].join(eol);
if (src.includes(old1)) {
    src = src.replace(old1, new1, 1);
    fixes.push('Fix 1: restored expected copied ranges to {9,17}');
} else if (src.includes(new1)) {
    fixes.push('Fix 1: already correct (skipped)');
} else {
    console.error('FAIL: Fix 1 pattern not found');
    process.exit(1);
}

// --- Fix 2: pass-through assert  ==>  assert.throws (translation coords fail) ---
const old2 = [
    "    await editorOptions.copySourcedMarkdown({",
    "        kind: 'selection',",
    "        text: '\\u8bd1\\u6587',",
    "        ranges: [{ from: 36, to: 38 }],",
    "    });",
    "    assert.deepEqual(copied.at(-1), {",
    "        kind: 'selection',",
    "        text: '\\u8bd1\\u6587',",
    "        ranges: [{ from: 36, to: 38 }],",
    "    });",
].join(eol);
const new2 = [
    "    assert.throws(() => editorOptions.copySourcedMarkdown({",
    "        kind: 'selection',",
    "        text: '\\u8bd1\\u6587',",
    "        ranges: [{ from: 36, to: 38 }],",
    "    }), /source/i);",
].join(eol);
if (src.includes(old2)) {
    src = src.replace(old2, new2, 1);
    fixes.push('Fix 2: restored assert.throws for translation coords');
} else if (src.includes(new2)) {
    fixes.push('Fix 2: already correct (skipped)');
} else {
    console.error('FAIL: Fix 2 pattern not found');
    process.exit(1);
}

writeFileSync(FILE, src, 'utf8');
console.log('OK:', fixes.join('; '));
