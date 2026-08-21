import {
    normalizeArxivID,
    normalizeDOI,
} from './citation-identifiers.js';
import { CitationProviderRequest } from './citation-provider-request.js';

const DEFAULT_API_BASE = 'https://api.openalex.org';
const MAX_BATCH_SIZE = 100;
const MAX_BATCH_CONCURRENCY = 4;
const MAX_REFERENCES = 1_000;
const MAX_OPENALEX_ID_LENGTH = 64;
const MAX_TITLE_LENGTH = 512;
const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_TEXT_LENGTH = 512;
const MAX_AUTHORS = 8;

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
        // Keep the argument explicit so callers can pass parsed author context
        // without making it part of the provider query (OpenAlex already
        // tokenizes the bounded citation text).
        void authorSearchText;
        const payload = await this.request.getJSON(this.#searchURL({
            query,
            year: normalizedYear,
            apiKey: boundedString(apiKey, 4_096).trim(),
        }), { signal, onRetry });
        const candidates = workResults(payload, this.request)
            .map(normalizeSearchCandidate)
            .filter(Boolean)
            .slice(0, MAX_SEARCH_RESULTS);
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
            select: 'id,title,publication_year,authorships,doi,ids,best_oa_location',
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
    if (!paperID || !title || !hasReliableIdentifier(identifiers)) {
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
    return {
        source: 'openalex',
        paperID,
        title,
        year: Number.isSafeInteger(rawYear) && rawYear >= 0 && rawYear <= 9_999
            ? rawYear
            : 0,
        authors,
        identifiers,
    };
}

function normalizeOpenAlexID(value) {
    const bounded = boundedString(value, MAX_OPENALEX_ID_LENGTH).trim();
    const match = /^(?:https?:\/\/openalex\.org\/)?(W[1-9]\d*)$/i.exec(bounded);
    return match ? match[1].toUpperCase() : '';
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
