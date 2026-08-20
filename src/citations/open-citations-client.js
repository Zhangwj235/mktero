import { normalizeDOI } from './citation-identifiers.js';
import { CitationProviderRequest } from './citation-provider-request.js';

const DEFAULT_API_BASE = 'https://api.opencitations.net/index/v2';
const MAX_REFERENCES = 1_000;
const MAX_CITED_FIELD_LENGTH = 16 * 1_024;

export class OpenCitationsClient {
    constructor({
        apiBase = DEFAULT_API_BASE,
        now = Date.now,
        ...requestOptions
    } = {}) {
        this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
        this.now = now;
        this.request = new CitationProviderRequest({
            providerName: 'OpenCitations',
            errorPrefix: 'OC',
            now,
            ...requestOptions,
        });
    }

    supports(paper) {
        return Boolean(normalizeDOI(paper?.doi));
    }

    async fetchReferences({
        doi = '',
        apiKey = '',
        signal,
        onRetry = () => {},
    } = {}) {
        const normalizedDOI = normalizeDOI(doi);
        if (!normalizedDOI) throw new TypeError('A DOI is required');
        const headers = {};
        const token = boundedString(apiKey, 4_096).trim();
        if (token) headers.authorization = token;
        let payload;
        try {
            payload = await this.request.getJSON(
                `${this.apiBase}/references/${encodeURIComponent(`doi:${normalizedDOI}`)}`,
                { headers, signal, onRetry }
            );
        }
        catch (error) {
            if (error?.code === 'OC_HTTP_ERROR' && error.status === 404) {
                return negativeResult(this.now());
            }
            throw error;
        }
        if (!Array.isArray(payload)) {
            throw this.request.invalidResponseError();
        }
        const dois = new Set();
        for (const entry of payload.slice(0, MAX_REFERENCES)) {
            if (!entry || typeof entry !== 'object') {
                throw this.request.invalidResponseError();
            }
            for (const value of citationDOIs(entry.cited)) dois.add(value);
        }
        if (!dois.size) return negativeResult(this.now());
        return {
            status: 'fetched',
            paperID: '',
            references: [...dois].slice(0, MAX_REFERENCES).map(doiValue => ({
                paperID: '',
                title: '',
                year: 0,
                doi: doiValue,
                arxivID: '',
                authors: [],
            })),
            truncated: payload.length > MAX_REFERENCES
                || dois.size > MAX_REFERENCES,
            fetchedAt: this.now(),
        };
    }
}

function citationDOIs(value) {
    const source = boundedString(value, MAX_CITED_FIELD_LENGTH);
    const results = [];
    const pattern = /(?:^|\s)doi:\s*(10\.\S+)/ig;
    for (const match of source.matchAll(pattern)) {
        const doi = normalizeDOI(match[1]);
        if (doi) results.push(doi);
    }
    return results;
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
