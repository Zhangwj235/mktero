import { findTextOccurrences } from '../markdown/text-normalization.js';
import {
    createPdfAnnotationTextIndex,
    expandPdfAnnotationSourceRange,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';
import {
    createVisibleMarkdownTextIndex,
} from '../markdown/markdown-visible-text.js';
import { resolvePDFPageIndexHint } from './markdown-source-map.js';

const MAX_MATCHABLE_MARKDOWN_LENGTH = 8 * 1024 * 1024;
const MAX_MATCH_CANDIDATES = 10_000;

export class MarkdownAnnotationOverlay {
    constructor({ extractor, onError = () => {} }) {
        if (!extractor?.extract) {
            throw new TypeError('An annotation extractor is required');
        }
        this.extractor = extractor;
        this.onError = onError;
    }

    async resolve(itemID, markdown, { sourceMap = null } = {}) {
        if (typeof markdown !== 'string') {
            throw new TypeError('Markdown must be a string');
        }
        try {
            return await this.#resolve(itemID, markdown, sourceMap);
        }
        catch (error) {
            try {
                this.onError(error);
            }
            catch {
                // Annotation diagnostics must not make PDF conversion fail.
            }
            return {
                ...createEmptyAnnotationOverlay(),
                warning: 'Zotero PDF annotations could not be loaded.',
            };
        }
    }

    async #resolve(itemID, markdown, sourceMap) {
        const annotations = await this.extractor.extract(itemID);
        if (!annotations.length) return createEmptyAnnotationOverlay();
        if (markdown.length > MAX_MATCHABLE_MARKDOWN_LENGTH) {
            throw new Error(
                'Markdown exceeds the PDF annotation matching safety limit'
            );
        }
        const index = createVisibleMarkdownTextIndex(markdown);
        let normalizedIndex = null;
        const matched = [];
        const unmatched = [];
        let previousSourceTo = 0;

        for (const annotation of annotations) {
            const candidateResult = findTextOccurrences(
                index.text,
                annotation.text,
                MAX_MATCH_CANDIDATES
            );
            const candidates = candidateResult.offsets;
            const exactRanges = candidateResult.truncated
                ? []
                : candidates.map(candidate => expandPdfAnnotationSourceRange(
                    markdown,
                    index.sourceRange(candidate, annotation.text.length)
                ));
            const exactRange = selectCandidateRange(
                selectPageCandidates(
                    exactRanges,
                    annotation.pageIndex,
                    sourceMap,
                    markdown.length
                ),
                previousSourceTo
            );
            if (exactRange) {
                matched.push(resolvedAnnotation(
                    annotation,
                    'exact',
                    exactRange
                ));
                previousSourceTo = Math.max(previousSourceTo, exactRange.to);
                continue;
            }
            const normalizedText = normalizePdfAnnotationText(annotation.text);
            if (!normalizedIndex && !candidates.length) {
                normalizedIndex = createPdfAnnotationTextIndex(
                    index.text,
                    offset => index.sourceOffsetAt(offset)
                );
            }
            const normalizedCandidateResult = candidates.length
                ? { offsets: [], truncated: false }
                : findTextOccurrences(
                    normalizedIndex.text,
                    normalizedText,
                    MAX_MATCH_CANDIDATES
                );
            const normalizedCandidates = normalizedCandidateResult.offsets;
            const normalizedRanges = normalizedCandidateResult.truncated
                ? []
                : normalizedCandidates.map(candidate => (
                    normalizedIndex.sourceRange(
                        candidate,
                        normalizedText.length
                    )
                ));
            const normalizedRange = selectCandidateRange(
                selectPageCandidates(
                    normalizedRanges,
                    annotation.pageIndex,
                    sourceMap,
                    markdown.length
                ),
                previousSourceTo
            );
            if (normalizedRange) {
                matched.push(resolvedAnnotation(
                    annotation,
                    'normalized',
                    normalizedRange
                ));
                previousSourceTo = Math.max(previousSourceTo, normalizedRange.to);
                continue;
            }
            const ambiguous = candidateResult.truncated
                || candidates.length
                || normalizedCandidateResult.truncated
                || normalizedCandidates.length;
            unmatched.push({
                ...annotation,
                reason: ambiguous ? 'ambiguous' : 'not-found',
            });
        }
        return { matched, unmatched };
    }
}

function resolvedAnnotation(annotation, matchKind, range) {
    return {
        ...annotation,
        matchKind,
        ranges: [range],
    };
}

function selectCandidateRange(ranges, previousSourceTo) {
    if (ranges.length === 1) return ranges[0];
    if (!previousSourceTo) return null;
    const following = ranges.filter(range => range.from >= previousSourceTo);
    return following.length === 1 ? following[0] : null;
}

function selectPageCandidates(ranges, pageIndex, sourceMap, documentLength) {
    if (ranges.length <= 1
        || !Number.isInteger(pageIndex)
        || pageIndex < 0
        || !Array.isArray(sourceMap)) {
        return ranges;
    }

    const pageCandidates = [];
    let hasPageEvidence = false;
    let hasUnknownCandidate = false;
    for (const range of ranges) {
        const candidatePage = resolvePDFPageIndexHint(
            sourceMap,
            range,
            documentLength
        );
        if (candidatePage === null) {
            hasUnknownCandidate = true;
            continue;
        }
        hasPageEvidence = true;
        if (candidatePage === pageIndex) pageCandidates.push(range);
    }
    return hasPageEvidence && !hasUnknownCandidate
        ? pageCandidates
        : ranges;
}

export function createEmptyAnnotationOverlay() {
    return { matched: [], unmatched: [] };
}
