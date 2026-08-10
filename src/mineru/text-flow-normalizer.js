import { isValidSourceMapEntry } from '../core/markdown-source-map.js';

const MAX_CONTINUATION_TOP = 220;
const MIN_ANCHOR_WORDS = 6;
const INCOMPLETE_TEXT_END_PATTERN = /(?:[+\-*/=<>≤≥≠]|[([{,;:])\s*$/u;
const NON_PROSE_BLOCK_START_PATTERN = /^(?:#{1,6}(?:\s|$)|(?:[-+*]|\d+[.)])\s+|>\s|```|~~~|<)/u;

export function reassembleMinerUTextFlow(markdown, sourceMap) {
    const source = String(markdown || '');
    if (!source || !Array.isArray(sourceMap)) return source;

    const entries = sourceMap
        .filter(entry => isValidSourceMapEntry(entry, source.length))
        .sort((left, right) => left.markdownFrom - right.markdownFrom);
    const edits = [];
    const usedAnchors = new Set();

    for (const continuation of entries) {
        const continuationPage = singlePageIndex(continuation);
        if (continuation.type !== 'text'
            || continuationPage === null
            || !isTopOfPage(continuation)
            || !startsLikeContinuation(source, continuation)) {
            continue;
        }

        const anchor = findContinuationAnchor(
            source,
            entries,
            continuation,
            continuationPage,
            usedAnchors
        );
        if (!anchor) continue;

        const removal = continuationRemovalRange(source, continuation);
        if (!removal) continue;

        const anchorSource = source
            .slice(anchor.markdownFrom, anchor.markdownTo)
            .trimEnd();
        const continuationSource = source
            .slice(continuation.markdownFrom, continuation.markdownTo)
            .trimStart();
        if (!anchorSource || !continuationSource) continue;

        edits.push({
            from: anchor.markdownFrom,
            to: anchor.markdownTo,
            replacement: `${anchorSource} ${continuationSource}`,
        }, {
            from: removal.from,
            to: removal.to,
            replacement: '',
        });
        usedAnchors.add(anchor);
    }

    return applyNonOverlappingEdits(source, edits);
}

function findContinuationAnchor(
    source,
    entries,
    continuation,
    continuationPage,
    usedAnchors
) {
    const candidates = entries
        .filter(entry => (
            entry.type === 'text'
            && entry.markdownTo <= continuation.markdownFrom
            && singlePageIndex(entry) === continuationPage - 1
            && !usedAnchors.has(entry)
            && endsWithIncompleteText(source, entry)
            && hasOnlyInterveningCharts(
                source,
                entries,
                entry,
                continuation,
                continuationPage - 1
            )
        ))
        .sort((left, right) => right.markdownFrom - left.markdownFrom);
    return candidates[0] || null;
}

function hasOnlyInterveningCharts(
    source,
    entries,
    anchor,
    continuation,
    pageIndex
) {
    let cursor = anchor.markdownTo;
    let chartCount = 0;
    for (const entry of entries) {
        if (entry.markdownFrom < anchor.markdownTo) continue;
        if (entry.markdownFrom >= continuation.markdownFrom) break;
        if (entry.markdownTo > continuation.markdownFrom
            || source.slice(cursor, entry.markdownFrom).trim()) {
            return false;
        }
        if (entry.type !== 'chart' || singlePageIndex(entry) !== pageIndex) {
            return false;
        }
        chartCount++;
        cursor = entry.markdownTo;
    }
    return chartCount > 0
        && !source.slice(cursor, continuation.markdownFrom).trim();
}

function endsWithIncompleteText(source, entry) {
    const text = source.slice(entry.markdownFrom, entry.markdownTo).trimEnd();
    if (!INCOMPLETE_TEXT_END_PATTERN.test(text)) return false;
    const words = text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) || [];
    return words.length >= MIN_ANCHOR_WORDS;
}

function startsLikeContinuation(source, entry) {
    const text = source.slice(entry.markdownFrom, entry.markdownTo).trimStart();
    return Boolean(text) && !NON_PROSE_BLOCK_START_PATTERN.test(text);
}

function isTopOfPage(entry) {
    return entry.locations.every(location => (
        location.bbox[1] <= MAX_CONTINUATION_TOP
    ));
}

function singlePageIndex(entry) {
    const pageIndex = entry.locations[0]?.pageIndex;
    return entry.locations.every(location => location.pageIndex === pageIndex)
        ? pageIndex
        : null;
}

function continuationRemovalRange(source, entry) {
    const preceding = /(?:\r?\n[ \t]*){2}$/.exec(
        source.slice(0, entry.markdownFrom)
    );
    if (!preceding) return null;
    return {
        from: entry.markdownFrom - preceding[0].length,
        to: entry.markdownTo,
    };
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
