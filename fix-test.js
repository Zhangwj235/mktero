import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'test/markdown-window.test.js';
let src = readFileSync(FILE, 'utf8');

// Detect line ending: if file contains \r\n, use CRLF; otherwise LF.
const eol = src.includes('\r\n') ? '\r\n' : '\n';

// --- Edit 1: expected copied ranges 9->17  ==>  15->23 (pass-through) ---
const old1 = [
    "    assert.deepEqual(copied, [{",
    "        kind: 'selection',",
    "        text: 'Original',",
    "        ranges: [{ from: 9, to: 17 }],",
    "    }]);",
].join(eol);
const new1 = [
    "    assert.deepEqual(copied, [{",
    "        kind: 'selection',",
    "        text: 'Original',",
    "        ranges: [{ from: 15, to: 23 }],",
    "    }]);",
].join(eol);

if (!src.includes(old1)) {
    console.error('FAIL: Edit 1 pattern not found.');
    console.error('Detected EOL:', JSON.stringify(eol));
    console.error('This means the file differs from the expected original.');
    console.error('Try: git checkout -- test/markdown-window.test.js  then retry.');
    process.exit(1);
}
src = src.replace(old1, new1);

// --- Edit 2: assert.throws for translation coords  ==>  pass-through assert ---
// File uses literal JS unicode escapes \u8bd1\u6587 (backslash-u, not real chars).
const old2 = [
    "    assert.throws(() => editorOptions.copySourcedMarkdown({",
    "        kind: 'selection',",
    "        text: '\\u8bd1\\u6587',",
    "        ranges: [{ from: 36, to: 38 }],",
    "    }), /source/i);",
].join(eol);
const new2 = [
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

if (!src.includes(old2)) {
    console.error('FAIL: Edit 2 pattern not found.');
    console.error('Detected EOL:', JSON.stringify(eol));
    process.exit(1);
}
src = src.replace(old2, new2);

writeFileSync(FILE, src, 'utf8');
console.log('OK: both edits applied to', FILE);
console.log('Detected EOL:', JSON.stringify(eol));
console.log('Now run: npm test -- test/markdown-window.test.js');
