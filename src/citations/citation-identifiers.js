const MAX_IDENTIFIER_INPUT_LENGTH = 4_096;
const MAX_EXTRA_LENGTH = 16 * 1_024;
const DEFAULT_MAX_TITLE_LENGTH = 512;
const DEFAULT_MAX_AUTHOR_LENGTH = 512;
const DEFAULT_MAX_AUTHORS = 100;
const DOI_PATTERN = /^10\.\d{4,9}\/[!#$%&'*+./0-9:;<=>?@A-Z[\]^_`a-z{|}~-]+$/;
const CURRENT_ARXIV_PATTERN = /^\d{4}\.\d{4,5}$/;
const LEGACY_ARXIV_PATTERN = /^[a-z][a-z0-9.-]*\/[0-9]{7}$/;

export function normalizeDOI(value) {
    let normalized = boundedString(value, MAX_IDENTIFIER_INPUT_LENGTH).trim();
    normalized = normalized
        .replace(/^doi\s*:\s*/i, '')
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
        .trim();
    if (normalized.startsWith('<') && normalized.endsWith('>')) {
        normalized = normalized.slice(1, -1).trim();
    }
    if (!DOI_PATTERN.test(normalized)) return '';
    return normalized.toLowerCase();
}

export function normalizeArxivID(value) {
    let normalized = boundedString(value, MAX_IDENTIFIER_INPUT_LENGTH).trim();
    normalized = normalized
        .replace(/^arxiv(?:\s+id)?\s*:\s*/i, '')
        .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
        .replace(/[?#].*$/, '')
        .replace(/\.pdf$/i, '')
        .replace(/v\d+$/i, '')
        .trim()
        .toLowerCase();
    if (!CURRENT_ARXIV_PATTERN.test(normalized)
        && !LEGACY_ARXIV_PATTERN.test(normalized)) {
        return '';
    }
    return normalized;
}

export function extractCitationIdentifiers({ doi = '', extra = '' } = {}) {
    const source = boundedString(extra, MAX_EXTRA_LENGTH);
    let normalizedDOI = normalizeDOI(doi);
    let arxivID = '';
    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!normalizedDOI) {
            const doiMatch = /^(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)(\S+)$/i
                .exec(line);
            if (doiMatch) normalizedDOI = normalizeDOI(doiMatch[1]);
        }
        if (!arxivID) {
            const arxivMatch = /^(?:arxiv(?:\s+id)?\s*:\s*)(\S+)$/i
                .exec(line)
                || /^(https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/\S+)$/i
                    .exec(line);
            if (arxivMatch) arxivID = normalizeArxivID(arxivMatch[1]);
        }
        if (normalizedDOI && arxivID) break;
    }
    return { doi: normalizedDOI, arxivID };
}

export function normalizeSemanticScholarPaper(value, {
    maxTitleLength = DEFAULT_MAX_TITLE_LENGTH,
    maxAuthorLength = DEFAULT_MAX_AUTHOR_LENGTH,
    maxAuthors = DEFAULT_MAX_AUTHORS,
} = {}) {
    if (!value || typeof value !== 'object') return null;
    const paperID = boundedString(
        value.paperId ?? value.paperID,
        MAX_IDENTIFIER_INPUT_LENGTH
    ).trim();
    if (!paperID || !/^[A-Za-z0-9._:-]+$/.test(paperID)) return null;
    const title = collapseWhitespace(
        boundedString(value.title, normalizedLimit(maxTitleLength, 1, 4_096))
    );
    const rawYear = Number(value.year);
    const year = Number.isSafeInteger(rawYear) && rawYear >= 0 && rawYear <= 9999
        ? rawYear
        : 0;
    const externalIDs = value.externalIds && typeof value.externalIds === 'object'
        ? value.externalIds
        : {};
    const authors = Array.isArray(value.authors)
        ? value.authors.slice(0, normalizedLimit(maxAuthors, 0, 1_000))
            .map(author => collapseWhitespace(boundedString(
                author?.name,
                normalizedLimit(maxAuthorLength, 1, 4_096)
            )))
            .filter(Boolean)
        : [];
    return {
        paperID,
        title,
        year,
        doi: normalizeDOI(externalIDs.DOI),
        arxivID: normalizeArxivID(externalIDs.ArXiv),
        authors,
    };
}

function boundedString(value, maximum) {
    return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function collapseWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedLimit(value, minimum, maximum) {
    return Number.isSafeInteger(value)
        ? Math.max(minimum, Math.min(value, maximum))
        : maximum;
}
