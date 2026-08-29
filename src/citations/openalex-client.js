import {
    normalizeArxivID,
    normalizeDOI,
    normalizeOpenAlexID,
} from './citation-identifiers.js';
import { CitationProviderRequest } from './citation-provider-request.js';

const DEFAULT_API_BASE = 'https://api.openalex.org';
const MAX_BATCH_SIZE = 100;
const MAX_BATCH_CONCURRENCY = 4;
const MAX_REFERENCES = 1_000;
const MAX_TITLE_LENGTH = 512;
const MAX_SEARCH_RESULTS = 10;
const MAX_METADATA_CANDIDATES = 3;
const MAX_SEARCH_TEXT_LENGTH = 512;
const MAX_AUTHORS = 8;
const MIN_TITLE_SIMILARITY = 0.65;
const MIN_ADJACENT_YEAR_TITLE_SIMILARITY = 0.9;

export class OpenAlexClient {
    constructor({
        apiBase = DEFAULT_API_BASE,
        now = Date.now,
        ...requestOptions
    } = {}) {
        this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
        this.now = now;
        this.openAlexIDByDOI = new Map();
        this.request = new CitationProviderRequest({
            providerName: 'OpenAlex',
            errorPrefix: 'OPENALEX',
            now,
            ...requestOptions,
        });
    }

    supports(paper) {
        return Boolean(normalizeDOI(paper?.doi));
    }

    async resolveOpenAccessPDF({
        doi = '',
        apiKey = '',
        signal,
        onRetry = () => {},
    } = {}) {
        const normalizedDOI = normalizeDOI(doi);
        if (!normalizedDOI) return null;
        const payload = await this.request.getJSON(this.#worksURL({
            dois: [normalizedDOI],
            select: 'best_oa_location,locations',
            perPage: 1,
            apiKey: boundedString(apiKey, 4_096).trim(),
        }), { signal, onRetry });
        const [work] = workResults(payload, this.request);
        if (!work) return null;
        const candidates = [
            work.best_oa_location?.pdf_url,
            ...(Array.isArray(work.locations)
                ? work.locations.map(location => location?.pdf_url)
                : []),
        ];
        return candidates.map(normalizePublicURL).find(Boolean) || null;
    }

    async searchReferences({
        text = '',
        year = 0,
        authorSearchText = '',
        apiKey = '',
        signal,
        onRetry = () => {},
    } = {}) {
        const query = collapseWhitespace(
            boundedString(text, MAX_SEARCH_TEXT_LENGTH)
        );
        if (!query) {
            return {
                status: 'unindexed',
                candidates: [],
                searchedAt: this.now(),
            };
        }
        const rawYear = Number(year);
        const normalizedYear = Number.isSafeInteger(rawYear)
            && rawYear >= 0 && rawYear <= 9_999
            ? rawYear
            : 0;
        const titleQuery = extractTitleQuery(query);
        const boundedAuthorSearchText = boundedString(
            authorSearchText,
            MAX_SEARCH_TEXT_LENGTH
        );
        const normalizedAPIKey = boundedString(apiKey, 4_096).trim();
        const searchPlans = searchQueries(query).map(searchQuery => ({
            query: searchQuery,
            year: normalizedYear,
        }));
        if (normalizedYear) {
            searchPlans.push({ query: titleQuery, year: 0 });
        }
        let candidates = [];
        for (const searchPlan of searchPlans) {
            const payload = await this.request.getJSON(this.#searchURL({
                query: searchPlan.query,
                year: searchPlan.year,
                apiKey: normalizedAPIKey,
            }), { signal, onRetry });
            candidates = workResults(payload, this.request)
                .map(normalizeSearchCandidate)
                .filter(Boolean);
            candidates = selectSearchCandidates(candidates, {
                title: titleQuery,
                year: normalizedYear,
                authorSearchText: boundedAuthorSearchText,
            });
            if (candidates.length) break;
        }
        return {
            status: candidates.length ? 'found' : 'unindexed',
            candidates,
            searchedAt: this.now(),
        };
    }

    cacheScopeIdentifiers(papers, focus) {
        const focusDOI = normalizeDOI(focus?.doi);
        return (Array.isArray(papers) ? papers : [])
            .map(paper => normalizeDOI(paper?.doi))
            .filter(doi => doi && doi !== focusDOI)
            .sort()
            .map(doi => `doi:${doi}`);
    }

    async fetchReferences({
        doi = '',
        papers = [],
        apiKey = '',
        signal,
        onRetry = () => {},
    } = {}) {
        const normalizedDOI = normalizeDOI(doi);
        if (!normalizedDOI) throw new TypeError('A DOI is required');
        if (!Array.isArray(papers)) {
            throw new TypeError('Citation papers are required');
        }
        const normalizedAPIKey = boundedString(apiKey, 4_096).trim();
        const [focusWork] = await Promise.all([
            this.#fetchFocusWork(normalizedDOI, normalizedAPIKey, signal, onRetry),
            this.#resolveLocalDOIs(
                papers,
                normalizedDOI,
                normalizedAPIKey,
                signal,
                onRetry
            ),
        ]);
        if (!focusWork) return negativeResult(this.now());
        const paperByDOI = uniquePaperDOIIndex(papers);
        paperByDOI.delete(normalizedDOI);
        const paperByOpenAlexID = uniqueOpenAlexIDIndex(
            paperByDOI,
            this.openAlexIDByDOI
        );
        const references = [];
        const seen = new Set();
        for (const rawID of focusWork.referencedWorks) {
            const openAlexID = normalizeOpenAlexID(rawID);
            const localPaper = paperByOpenAlexID.get(openAlexID);
            const referenceDOI = normalizeDOI(localPaper?.doi);
            if (!localPaper || !referenceDOI || seen.has(referenceDOI)) continue;
            seen.add(referenceDOI);
            references.push(localReference(localPaper, openAlexID));
            if (references.length >= MAX_REFERENCES) break;
        }
        return {
            status: references.length ? 'fetched' : 'unindexed',
            paperID: references.length ? focusWork.id : '',
            references,
            truncated: focusWork.referencedWorks.length > MAX_REFERENCES,
            fetchedAt: this.now(),
        };
    }

    async #fetchFocusWork(doi, apiKey, signal, onRetry) {
        const payload = await this.request.getJSON(this.#worksURL({
            dois: [doi],
            select: 'id,referenced_works',
            perPage: 1,
            apiKey,
        }), { signal, onRetry });
        const results = workResults(payload, this.request);
        if (!results.length) return null;
        if (results.length !== 1) throw this.request.invalidResponseError();
        const work = results[0];
        const id = normalizeOpenAlexID(work?.id);
        if (!id || !Array.isArray(work?.referenced_works)) {
            throw this.request.invalidResponseError();
        }
        if (work.referenced_works.length > 100_000
            || work.referenced_works.some(value => !normalizeOpenAlexID(value))) {
            throw this.request.invalidResponseError();
        }
        return { id, referencedWorks: work.referenced_works };
    }

    async #resolveLocalDOIs(papers, focusDOI, apiKey, signal, onRetry) {
        const dois = [...new Set(papers.map(paper => normalizeDOI(paper?.doi))
            .filter(doi => doi && doi !== focusDOI))]
            .filter(doi => !this.openAlexIDByDOI.has(doi));
        const batches = [];
        for (let index = 0; index < dois.length; index += MAX_BATCH_SIZE) {
            batches.push(dois.slice(index, index + MAX_BATCH_SIZE));
        }
        let offset = 0;
        const workers = Array.from({
            length: Math.min(MAX_BATCH_CONCURRENCY, batches.length),
        }, async () => {
            while (offset < batches.length) {
                const batch = batches[offset++];
                const payload = await this.request.getJSON(this.#worksURL({
                    dois: batch,
                    select: 'id,doi',
                    perPage: MAX_BATCH_SIZE,
                    apiKey,
                }), { signal, onRetry });
                const requestedDOIs = new Set(batch);
                const mappings = new Map();
                for (const work of workResults(payload, this.request)) {
                    const workDOI = normalizeDOI(work?.doi);
                    const workID = normalizeOpenAlexID(work?.id);
                    if (!workDOI || !workID || !requestedDOIs.has(workDOI)) {
                        throw this.request.invalidResponseError();
                    }
                    const workIDs = mappings.get(workDOI) || new Set();
                    workIDs.add(workID);
                    mappings.set(workDOI, workIDs);
                }
                for (const [workDOI, workIDs] of mappings) {
                    if (workIDs.size === 1) {
                        this.openAlexIDByDOI.set(workDOI, [...workIDs][0]);
                    }
                }
            }
        });
        await Promise.all(workers);
    }

    #worksURL({ dois, select, perPage, apiKey }) {
        const params = new URLSearchParams({
            filter: `doi:${dois.join('|')}`,
            select,
            per_page: String(perPage),
        });
        if (apiKey) params.set('api_key', apiKey);
        return `${this.apiBase}/works?${params}`;
    }

    #searchURL({ query, year, apiKey }) {
        const params = new URLSearchParams({
            search: query,
            select: 'id,title,publication_year,type,authorships,doi,ids,best_oa_location,primary_location',
            per_page: String(MAX_SEARCH_RESULTS),
        });
        if (year) params.set('filter', `publication_year:${year}`);
        if (apiKey) params.set('api_key', apiKey);
        return `${this.apiBase}/works?${params}`;
    }
}

function workResults(payload, request) {
    if (!payload || typeof payload !== 'object'
        || !Array.isArray(payload.results)
        || payload.results.length > MAX_BATCH_SIZE) {
        throw request.invalidResponseError();
    }
    return payload.results;
}

function searchQueries(query) {
    const titleQuery = extractTitleQuery(query);
    return titleQuery && titleQuery !== query
        ? [query, titleQuery]
        : [query];
}

function extractTitleQuery(query) {
    let candidate = collapseWhitespace(query)
        .replace(/\s*\([^()]{0,256}\b(?:18|19|20)\d{2}[a-z]?\b[^()]{0,256}\)\s*\.?$/iu, '')
        .replace(/\s+\b\d+(?:st|nd|rd|th)\s+(?:edn|edition)\b\s*\.?$/iu, '')
        .replace(/\s+\b(?:edn|edition)\b\s*\.?$/iu, '')
        .replace(/\s+\b(?:18|19|20)\d{2}[a-z]?\b\s*\.?$/iu, '')
        .trim();
    const quotedTitle = longestQuotedTitle(candidate);
    if (quotedTitle) {
        candidate = quotedTitle;
    }
    else {
        const segments = candidate
            .split(/(?:\.\s+|[。；;]\s*)/u)
            .map(value => value.trim())
            .filter(value => value.length >= 12);
        candidate = titleBeforeConferenceVenue(segments)
            || segments.sort((left, right) => right.length - left.length)[0]
            || candidate;
    }
    return collapseWhitespace(candidate).slice(0, MAX_SEARCH_TEXT_LENGTH);
}

function titleBeforeConferenceVenue(segments) {
    const venuePattern = /^in\s+(?:the\s+)?(?:proceedings\s+of\b|.{0,128}\b(?:conference|workshop|symposium)\b(?=\s+(?:on|of|for|in)\b|[,.:]|$))/iu;
    const venueIndex = segments.findIndex((segment, index) => (
        index > 0 && venuePattern.test(segment)
    ));
    return venueIndex > 0 ? segments[venueIndex - 1] : '';
}

function longestQuotedTitle(value) {
    const titles = [...String(value).matchAll(
        /(?:“([^”\r\n]{12,512})”|"([^"\r\n]{12,512})")/gu
    )].map(match => collapseWhitespace(match[1] || match[2])
        .replace(/[,.，。]+$/u, '')
        .trim())
        .filter(Boolean);
    return titles.sort((left, right) => right.length - left.length)[0] || '';
}

function uniquePaperDOIIndex(papers) {
    const candidates = new Map();
    for (const paper of papers) {
        const doi = normalizeDOI(paper?.doi);
        if (!doi) continue;
        const matches = candidates.get(doi) || [];
        matches.push(paper);
        candidates.set(doi, matches);
    }
    return new Map([...candidates].flatMap(([doi, matches]) => (
        matches.length === 1 ? [[doi, matches[0]]] : []
    )));
}

function uniqueOpenAlexIDIndex(paperByDOI, openAlexIDByDOI) {
    const candidates = new Map();
    for (const [doi, paper] of paperByDOI) {
        const openAlexID = openAlexIDByDOI.get(doi);
        if (!openAlexID) continue;
        const matches = candidates.get(openAlexID) || [];
        matches.push(paper);
        candidates.set(openAlexID, matches);
    }
    return new Map([...candidates].flatMap(([openAlexID, matches]) => (
        matches.length === 1 ? [[openAlexID, matches[0]]] : []
    )));
}

function localReference(paper, paperID) {
    const rawYear = Number(paper?.year);
    return {
        paperID,
        title: collapseWhitespace(boundedString(paper?.title, MAX_TITLE_LENGTH)),
        year: Number.isSafeInteger(rawYear) && rawYear >= 0 && rawYear <= 9_999
            ? rawYear
            : 0,
        doi: normalizeDOI(paper?.doi),
        arxivID: '',
        authors: [],
    };
}

function normalizeSearchCandidate(work) {
    const paperID = normalizeOpenAlexID(work?.id);
    const title = collapseWhitespace(
        boundedString(work?.title, MAX_TITLE_LENGTH)
    );
    const identifiers = {
        doi: normalizeDOI(work?.doi),
        arxivID: normalizeArxivID(work?.ids?.arxiv),
        pmid: normalizePMID(work?.ids?.pmid),
        pdfURL: normalizePublicURL(work?.best_oa_location?.pdf_url),
    };
    const hasStandardIdentifier = hasReliableIdentifier(identifiers);
    if (!hasStandardIdentifier) {
        identifiers.openAlexID = normalizeOpenAlexID(work?.ids?.openalex);
    }
    if (!paperID || !title || (!hasStandardIdentifier && !identifiers.openAlexID)) {
        return null;
    }
    const rawYear = Number(work?.publication_year);
    const authors = Array.isArray(work?.authorships)
        ? work.authorships.slice(0, MAX_AUTHORS)
            .map(authorship => collapseWhitespace(boundedString(
                authorship?.author?.display_name,
                MAX_TITLE_LENGTH
            )))
            .filter(Boolean)
        : [];
    const candidate = {
        source: 'openalex',
        paperID,
        title,
        year: Number.isSafeInteger(rawYear) && rawYear >= 0 && rawYear <= 9_999
            ? rawYear
            : 0,
        authors,
        identifiers,
    };
    if (!hasStandardIdentifier) {
        candidate.metadata = normalizeMetadata(work, {
            title,
            year: candidate.year,
            authors,
        });
    }
    return candidate;
}

function selectSearchCandidates(candidates, {
    title,
    year,
    authorSearchText,
}) {
    const normalizedTitle = normalizeSearchText(title);
    if (!normalizedTitle) return [];
    const normalizedAuthors = normalizeSearchText(authorSearchText);
    const ranked = candidates.flatMap(candidate => {
        const candidateTitle = normalizeSearchText(candidate.title);
        const titleSimilarity = tokenSimilarity(normalizedTitle, candidateTitle);
        const titleExact = candidateTitle === normalizedTitle;
        const authorCompatible = firstAuthorMatches(
            normalizedAuthors,
            candidate.authors
        );
        const yearDifference = year && candidate.year
            ? Math.abs(candidate.year - year)
            : Number.POSITIVE_INFINITY;
        const adjacentYearMatch = yearDifference === 1
            && titleSimilarity >= MIN_ADJACENT_YEAR_TITLE_SIMILARITY
            && authorCompatible;
        if (year && yearDifference !== 0 && !adjacentYearMatch) return [];
        const exact = Boolean(year)
            && authorCompatible
            && (
                titleExact && yearDifference === 0
                || adjacentYearMatch
            );
        if (!titleExact && titleSimilarity < MIN_TITLE_SIMILARITY) return [];
        return [{
            candidate: {
                ...candidate,
                matchConfidence: exact ? 'exact' : 'probable',
            },
            exact,
            score: titleSimilarity
                + (normalizedAuthors && authorCompatible ? 0.1 : 0),
        }];
    });
    const exact = ranked.filter(result => result.exact);
    return (exact.length ? exact : ranked)
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_METADATA_CANDIDATES)
        .map(result => result.candidate);
}

function firstAuthorMatches(normalizedAuthors, authors) {
    if (!normalizedAuthors || !Array.isArray(authors) || !authors.length) {
        return false;
    }
    const candidateTokens = normalizeSearchText(authors[0]).split(' ');
    const expectedTokens = normalizedAuthors
        .split(' ')
        .slice(0, candidateTokens.length);
    const surname = [...candidateTokens]
        .reverse()
        .find(token => token.length > 1);
    return Boolean(surname && expectedTokens.includes(surname));
}

function tokenSimilarity(left, right) {
    if (!left || !right) return 0;
    if (left === right) return 1;
    const leftTokens = new Set(left.split(' '));
    const rightTokens = new Set(right.split(' '));
    let shared = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) shared++;
    }
    return (2 * shared) / (leftTokens.size + rightTokens.size);
}

function normalizeSearchText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/gu, ' ');
}

function normalizeMetadata(work, fallback) {
    return {
        itemType: normalizeItemType(work?.type),
        title: fallback.title,
        year: fallback.year,
        authors: fallback.authors,
        publisher: collapseWhitespace(boundedString(
            work?.primary_location?.source?.display_name
                || work?.primary_location?.raw_source_name,
            MAX_TITLE_LENGTH
        )),
        url: normalizePublicURL(work?.primary_location?.landing_page_url),
    };
}

function normalizeItemType(value) {
    return {
        article: 'journalArticle',
        'book-chapter': 'bookSection',
        book: 'book',
        dissertation: 'thesis',
        report: 'report',
        'conference-paper': 'conferencePaper',
    }[String(value || '').toLowerCase()] || 'document';
}

function negativeResult(fetchedAt) {
    return {
        status: 'unindexed',
        paperID: '',
        references: [],
        truncated: false,
        fetchedAt,
    };
}

function boundedString(value, maximum) {
    return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function collapseWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePublicURL(value) {
    if (typeof value !== 'string' || value.length > 2_048) return '';
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        if (url.username || url.password) return '';
        url.hash = '';
        return url.toString();
    }
    catch {
        return '';
    }
}

function normalizePMID(value) {
    const bounded = boundedString(value, 128).trim();
    if (/^\d{1,12}$/u.test(bounded)) return bounded;
    try {
        const url = new URL(bounded);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        if (url.username || url.password) return '';
        const host = url.hostname.toLowerCase();
        const pubmedPath = /^\/(\d{1,12})\/?$/u.exec(url.pathname);
        if (host === 'pubmed.ncbi.nlm.nih.gov' && pubmedPath) {
            return pubmedPath[1];
        }
        const ncbiPath = /^\/pubmed\/(\d{1,12})\/?$/iu.exec(url.pathname);
        return host === 'www.ncbi.nlm.nih.gov' && ncbiPath
            ? ncbiPath[1]
            : '';
    }
    catch {
        return '';
    }
}

function hasReliableIdentifier(identifiers) {
    return Boolean(identifiers.doi || identifiers.arxivID || identifiers.pmid);
}
