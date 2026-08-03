import { isValidSourceMapEntry } from '../core/markdown-source-map.js';

const MIN_COLUMN_GAP = 20;
const MIN_COLUMN_WIDTH = 180;
const NON_PROSE_BLOCK_PATTERN = /^(?: {0,3}(?:#{1,6}(?:[ \t]|$)|>|(?:[-+*]|\d+[.)])[ \t]+|```|~~~)| {4}\S|\t\S|<|\$\$|\\\[|\\begin\{)/u;

export function reassembleMinerUColumnFlow(markdown, sourceMap) {
    const source = String(markdown || '');
    if (!source || !Array.isArray(sourceMap)) return source;

    const entries = sourceMap
        .filter(entry => isValidSourceMapEntry(entry, source.length))
        .sort((left, right) => left.markdownFrom - right.markdownFrom);
    const edits = [];
    let run = [];

    const flush = () => {
        if (run.length >= 2) {
            const edit = reorderRun(source, run);
            if (edit) edits.push(edit);
        }
        run = [];
    };

    for (const entry of entries) {
        if (!isReorderableTextEntry(source, entry)) {
            flush();
            continue;
        }
        const previous = run.at(-1);
        if (previous
            && (flowPageIndex(previous) !== flowPageIndex(entry)
                || source.slice(previous.markdownTo, entry.markdownFrom).trim())) {
            flush();
        }
        run.push(entry);
    }
    flush();

    return applyNonOverlappingEdits(source, edits);
}

function isReorderableTextEntry(source, entry) {
    if (entry.type !== 'text' || !entry.locations.length) return false;
    const text = source.slice(entry.markdownFrom, entry.markdownTo);
    return Boolean(text.trim()) && !NON_PROSE_BLOCK_PATTERN.test(text);
}

function reorderRun(source, entries) {
    const columns = detectColumns(entries);
    const ordered = [...entries].sort(compareLayoutPosition(columns));
    if (ordered.every((entry, index) => entry === entries[index])) return null;

    const separators = entries.slice(0, -1).map((entry, index) => (
        source.slice(entry.markdownTo, entries[index + 1].markdownFrom)
    ));
    const blocks = ordered.map(entry => (
        source.slice(entry.markdownFrom, entry.markdownTo)
    ));
    return {
        from: entries[0].markdownFrom,
        to: entries.at(-1).markdownTo,
        replacement: joinWithSeparators(blocks, separators),
    };
}

function compareLayoutPosition(columns) {
    return (left, right) => {
        const leftBox = entryStartLocation(left).bbox;
        const rightBox = entryStartLocation(right).bbox;
        if (columns) {
            const leftColumn = leftBox[0] < columns.split ? 0 : 1;
            const rightColumn = rightBox[0] < columns.split ? 0 : 1;
            if (leftColumn !== rightColumn) return leftColumn - rightColumn;
        }
        return leftBox[1] - rightBox[1]
            || leftBox[0] - rightBox[0]
            || left.markdownFrom - right.markdownFrom;
    };
}

function detectColumns(entries) {
    const sorted = [...entries].sort((left, right) => (
        entryStartLocation(left).bbox[0] - entryStartLocation(right).bbox[0]
    ));
    let best = null;
    for (let index = 0; index < sorted.length - 1; index++) {
        const leftEntries = sorted.slice(0, index + 1);
        const rightEntries = sorted.slice(index + 1);
        const leftEdge = Math.max(...leftEntries.map(entry => (
            entryStartLocation(entry).bbox[2]
        )));
        const rightEdge = Math.min(...rightEntries.map(entry => (
            entryStartLocation(entry).bbox[0]
        )));
        const gap = rightEdge - leftEdge;
        if (gap < MIN_COLUMN_GAP
            || !hasColumnWidth(leftEntries)
            || !hasColumnWidth(rightEntries)) {
            continue;
        }
        if (!best || gap > best.gap) {
            best = {
                gap,
                split: (leftEdge + rightEdge) / 2,
            };
        }
    }
    return best;
}

function hasColumnWidth(entries) {
    return Math.min(...entries.map(entry => {
        const bbox = entryStartLocation(entry).bbox;
        return bbox[2] - bbox[0];
    })) >= MIN_COLUMN_WIDTH;
}

function flowPageIndex(entry) {
    return entry.locations.reduce((pageIndex, location) => (
        pageIndex === null || location.pageIndex < pageIndex
            ? location.pageIndex
            : pageIndex
    ), null);
}

function entryStartLocation(entry) {
    return entry.locations.reduce((start, location) => {
        if (!start
            || location.pageIndex < start.pageIndex
            || (location.pageIndex === start.pageIndex
                && (location.bbox[1] < start.bbox[1]
                    || (location.bbox[1] === start.bbox[1]
                        && location.bbox[0] < start.bbox[0])))) {
            return location;
        }
        return start;
    }, null);
}

function joinWithSeparators(blocks, separators) {
    let result = blocks[0];
    for (let index = 1; index < blocks.length; index++) {
        result += separators[index - 1] + blocks[index];
    }
    return result;
}

function applyNonOverlappingEdits(source, edits) {
    const sorted = [...edits].sort((left, right) => right.from - left.from);
    let result = source;
    let lastFrom = source.length + 1;
    for (const edit of sorted) {
        if (edit.to > lastFrom) continue;
        result = result.slice(0, edit.from)
            + edit.replacement
            + result.slice(edit.to);
        lastFrom = edit.from;
    }
    return result;
}
