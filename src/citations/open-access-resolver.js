import {
    normalizeArxivID,
    normalizeDOI,
} from './citation-identifiers.js';

const MAX_URL_LENGTH = 2_048;

export function createOpenAccessResolver({
    semanticScholarClient = null,
    openAlexClient = null,
    getSemanticScholarAPIKey = () => '',
    getOpenAlexAPIKey = () => '',
} = {}) {
    return new OpenAccessResolver({
        semanticScholarClient,
        openAlexClient,
        getSemanticScholarAPIKey,
        getOpenAlexAPIKey,
    });
}

export class OpenAccessResolver {
    constructor({
        semanticScholarClient = null,
        openAlexClient = null,
        getSemanticScholarAPIKey = () => '',
        getOpenAlexAPIKey = () => '',
    } = {}) {
        this.semanticScholarClient = semanticScholarClient;
        this.openAlexClient = openAlexClient;
        this.getSemanticScholarAPIKey = getSemanticScholarAPIKey;
        this.getOpenAlexAPIKey = getOpenAlexAPIKey;
    }

    async resolve(reference, { signal, onRetry = () => {} } = {}) {
        throwIfAborted(signal);
        const identifiers = normalizeIdentifiers(reference);
        let providerError = null;
        if (identifiers.arxivID) {
            return {
                url: `https://arxiv.org/pdf/${identifiers.arxivID}.pdf`,
                source: 'arxiv',
            };
        }

        if (identifiers.doi && this.semanticScholarClient
            && typeof this.semanticScholarClient.resolveOpenAccessPDF
                === 'function') {
            try {
                const url = await this.semanticScholarClient
                    .resolveOpenAccessPDF({
                        doi: identifiers.doi,
                        apiKey: safeCredential(
                            this.getSemanticScholarAPIKey()
                        ),
                        signal,
                        onRetry,
                    });
                const normalizedURL = normalizePublicURL(url);
                if (normalizedURL) {
                    return { url: normalizedURL, source: 'semantic-scholar' };
                }
            }
            catch (error) {
                if (signal?.aborted) throw error;
                providerError ||= error;
            }
        }

        if (identifiers.doi && this.openAlexClient
            && typeof this.openAlexClient.resolveOpenAccessPDF
                === 'function') {
            try {
                const url = await this.openAlexClient.resolveOpenAccessPDF({
                    doi: identifiers.doi,
                    apiKey: safeCredential(this.getOpenAlexAPIKey()),
                    signal,
                    onRetry,
                });
                const normalizedURL = normalizePublicURL(url);
                if (normalizedURL) {
                    return { url: normalizedURL, source: 'openalex' };
                }
            }
            catch (error) {
                if (signal?.aborted) throw error;
                providerError ||= error;
            }
        }

        const explicitURL = normalizePublicURL(identifiers.pdfURL);
        if (explicitURL) return { url: explicitURL, source: 'reference' };
        if (isMeaningfulProviderError(providerError)) throw providerError;
        return null;
    }
}

export async function resolveOpenAccessPDF(reference, options = {}) {
    const resolver = options.resolver instanceof OpenAccessResolver
        ? options.resolver
        : createOpenAccessResolver(options);
    return resolver.resolve(reference, options);
}

function normalizeIdentifiers(reference) {
    return {
        doi: normalizeDOI(reference?.identifiers?.doi || reference?.doi),
        arxivID: normalizeArxivID(
            reference?.identifiers?.arxivID || reference?.arxivID
        ),
        pmid: normalizePMID(reference?.identifiers?.pmid || reference?.pmid),
        pdfURL: reference?.identifiers?.pdfURL || reference?.pdfURL || '',
    };
}

function normalizePublicURL(value) {
    if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return '';
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        if (url.username || url.password) return '';
        if (!isPublicHost(url.hostname)) return '';
        url.hash = '';
        return url.toString();
    }
    catch {
        return '';
    }
}

function isPublicHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost')
        || host.endsWith('.local') || host.endsWith('.internal')
        || host.endsWith('.home.arpa')) return false;
    const octets = host.split('.').map(value => Number(value));
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value)
        || value < 0 || value > 255)) {
        return !host.includes(':') || !isPrivateIPv6(host);
    }
    const [first, second] = octets;
    return first !== 0 && first !== 10 && first !== 127
        && !(first === 100 && second >= 64 && second <= 127)
        && !(first === 169 && second === 254)
        && !(first === 172 && second >= 16 && second <= 31)
        && !(first === 192 && second === 168);
}

function isPrivateIPv6(host) {
    return host === '::1' || host === '::'
        || /^(?:fc|fd|fe8|fe9|fea|feb)/iu.test(host)
        || /^::ffff:(?:0:)?(?:127\.|10\.|192\.168\.)/iu.test(host);
}

function isMeaningfulProviderError(error) {
    const code = String(error?.code || '');
    if (!code) return false;
    if (/_HTTP_ERROR$/u.test(code) && Number(error?.status) === 404) {
        return false;
    }
    return /(?:NETWORK|TIMEOUT|RATE|HTTP_ERROR|RESPONSE_TOO_LARGE)/u.test(code);
}

function safeCredential(value) {
    return typeof value === 'string' ? value.slice(0, 4_096).trim() : '';
}

function normalizePMID(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return /^\d{1,12}$/.test(normalized) ? normalized : '';
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
