import {
    normalizeArxivID,
    normalizeDOI,
} from '../citations/citation-identifiers.js';

const RELIABLE_IDENTIFIER_TYPES = Object.freeze([
    'doi',
    'arxivID',
    'pmid',
]);
const MAX_PDF_URL_LENGTH = 2_048;

export function createReferenceImportService(options) {
    return new ReferenceImportService(options);
}

export class ReferenceImportService {
    constructor({
        library,
        openAccessResolver = null,
        sourceItemID = null,
        createAbortController = () => new AbortController(),
    } = {}) {
        if (!library) throw new TypeError('A reference library is required');
        this.library = library;
        this.openAccessResolver = openAccessResolver;
        this.sourceItemID = sourceItemID;
        this.createAbortController = createAbortController;
        this.inFlight = new Map();
        this.controllers = new Set();
        this.listeners = new Set();
        this.disposed = false;
        this.generation = 0;
    }

    async listTargetLibraries(sourceItemID = this.sourceItemID, { signal } = {}) {
        throwIfAborted(signal);
        const libraries = await this.library.listLibraries({ signal });
        const defaultLibraryID = await this.library.getDefaultLibraryID(
            sourceItemID,
            { signal }
        );
        throwIfAborted(signal);
        return {
            libraries: Array.isArray(libraries) ? libraries : [],
            defaultLibraryID,
        };
    }

    async getStatus(reference, {
        targetLibraryID,
        signal,
    } = {}) {
        this.#assertActive();
        throwIfAborted(signal);
        const identifiers = normalizedIdentifiers(reference);
        const result = await this.library.find(reference, {
            targetLibraryID,
            signal,
        });
        throwIfAborted(signal);
        const selectedMatches = Array.isArray(result?.selectedMatches)
            ? result.selectedMatches
            : [];
        const otherMatches = Array.isArray(result?.otherMatches)
            ? result.otherMatches
            : [];
        const reliable = hasReliableIdentifier(identifiers);
        let state = 'unknown';
        if (selectedMatches.length) {
            state = selectedMatches.some(match => match.hasPDF)
                ? 'present'
                : 'present-no-pdf';
        }
        else if (otherMatches.length) {
            state = 'present-other-library';
        }
        else if (reliable) {
            state = 'absent';
        }
        const library = await this.#findLibrary(targetLibraryID, signal);
        return {
            status: state,
            state,
            identifiers,
            targetLibraryID,
            selectedMatches,
            otherMatches,
            candidates: Array.isArray(result?.candidates)
                ? result.candidates
                : [],
            match: selectedMatches[0] || null,
            canImport: Boolean(library?.editable && reliable),
            filesEditable: Boolean(library?.filesEditable),
            targetLibraryEditable: Boolean(library?.editable),
            targetLibraryFilesEditable: Boolean(library?.filesEditable),
        };
    }

    async importReference(reference, {
        targetLibraryID,
        signal,
        onProgress = () => {},
        retryPDF = false,
    } = {}) {
        this.#assertActive();
        const identifiers = normalizedIdentifiers(reference);
        const identifier = firstIdentifier(identifiers);
        if (!identifier.value) {
            return failedResult(
                reference,
                targetLibraryID,
                'REFERENCE_IDENTIFIER_UNSUPPORTED',
                { canImport: false }
            );
        }
        const library = await this.#findLibrary(targetLibraryID, signal);
        if (!library?.editable) {
            return failedResult(
                reference,
                targetLibraryID,
                'REFERENCE_LIBRARY_READ_ONLY',
                { canImport: false }
            );
        }
        const key = `${identifier.type}:${identifier.value}:${targetLibraryID}`;
        const existing = this.inFlight.get(key);
        if (existing) return existing;
        const promise = this.#runImport(reference, {
            identifiers,
            identifier,
            targetLibraryID,
            library,
            signal,
            onProgress,
            retryPDF,
        }).finally(() => {
            if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
        });
        this.inFlight.set(key, promise);
        return promise;
    }

    retryPDF(reference, options = {}) {
        return this.importReference(reference, {
            ...options,
            retryPDF: true,
        });
    }

    async openMatch(match) {
        this.#assertActive();
        if (!match?.itemID) {
            throw referenceError('REFERENCE_ITEM_UNAVAILABLE');
        }
        return this.library.openItem(match.itemID);
    }

    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    invalidate() {
        this.library.invalidate?.();
        this.generation++;
        this.#notify({ type: 'invalidated', generation: this.generation });
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const controller of this.controllers) controller.abort?.();
        this.controllers.clear();
        this.inFlight.clear();
        this.listeners.clear();
        this.generation++;
    }

    async #runImport(reference, {
        identifiers,
        identifier,
        targetLibraryID,
        library,
        signal,
        onProgress,
        retryPDF,
    }) {
        const controller = this.createAbortController();
        this.controllers.add(controller);
        const relayAbort = () => controller.abort?.(signal.reason);
        signal?.addEventListener('abort', relayAbort, { once: true });
        const operationSignal = controller.signal || signal;
        try {
            throwIfAborted(signal);
            const before = await this.getStatus(reference, {
                targetLibraryID,
                signal: operationSignal,
            });
            if (before.selectedMatches.length
                && before.selectedMatches.some(match => match.hasPDF)) {
                return before;
            }
            onProgress({ status: 'importing', stage: 'metadata' });

            let itemID = before.selectedMatches[0]?.itemID || null;
            let hasPDF = Boolean(before.selectedMatches[0]?.hasPDF);
            if (!itemID && before.otherMatches[0]
                && typeof this.library.copyItem === 'function') {
                onProgress({ status: 'importing', stage: 'copy' });
                const copied = await this.library.copyItem({
                    itemID: before.otherMatches[0].itemID,
                    targetLibraryID,
                });
                itemID = copied && typeof copied === 'object'
                    ? copied.itemID
                    : copied;
                hasPDF = copied && typeof copied === 'object'
                    ? Boolean(copied.hasPDF)
                    : Boolean(
                        before.otherMatches[0].hasPDF && library.filesEditable
                    );
                this.library.invalidate?.();
            }
            if (!itemID) {
                const translated = await this.library.translateIdentifier({
                    reference,
                    libraryID: targetLibraryID,
                    signal: operationSignal,
                });
                itemID = firstTranslatedItemID(translated?.items);
                hasPDF = Boolean(translated?.attachments?.length);
                if (!itemID) {
                    return failedResult(
                        reference,
                        targetLibraryID,
                        'REFERENCE_TRANSLATOR_EMPTY'
                    );
                }
            }

            let pdfError = null;
            if (!hasPDF && library.filesEditable
                && this.openAccessResolver
                && (retryPDF || !before.selectedMatches.length)) {
                onProgress({ status: 'importing', stage: 'pdf' });
                try {
                    const resolved = await this.openAccessResolver.resolve(
                        reference,
                        { signal: operationSignal }
                    );
                    if (resolved?.url) {
                        await this.library.attachPDF({
                            itemID,
                            libraryID: targetLibraryID,
                            url: resolved.url,
                            signal: operationSignal,
                        });
                        hasPDF = true;
                    }
                }
                catch (error) {
                    if (isAbortError(error)) throw error;
                    pdfError = safeErrorCode(error, 'REFERENCE_PDF_FAILED');
                }
            }
            this.library.invalidate?.();
            await this.library.refreshIndex?.({ signal: operationSignal });
            const after = await this.getStatus(reference, {
                targetLibraryID,
                signal: operationSignal,
            });
            const finalStatus = pdfError || (!hasPDF && !after.match?.hasPDF)
                ? 'present-no-pdf'
                : 'imported';
            const result = {
                ...after,
                status: finalStatus,
                state: finalStatus,
                importedItemID: itemID,
                pdfError,
                retryablePDF: finalStatus === 'present-no-pdf',
            };
            onProgress({ status: finalStatus, stage: pdfError ? 'pdf-failed' : 'done' });
            this.#notify({ type: 'updated', reference, result });
            return result;
        }
        catch (error) {
            if (isAbortError(error)) throw error;
            const result = failedResult(
                reference,
                targetLibraryID,
                safeErrorCode(error, 'REFERENCE_IMPORT_FAILED'),
                { canImport: Boolean(library?.editable) }
            );
            onProgress({ status: 'failed', stage: 'error', errorCode: result.errorCode });
            this.#notify({ type: 'updated', reference, result });
            return result;
        }
        finally {
            signal?.removeEventListener('abort', relayAbort);
            this.controllers.delete(controller);
        }
    }

    async #findLibrary(libraryID, signal) {
        const libraries = await this.library.listLibraries({ signal });
        return libraries.find(library => (
            String(library.libraryID) === String(libraryID)
        ));
    }

    #assertActive() {
        if (this.disposed) throw referenceError('REFERENCE_SERVICE_DISPOSED');
    }

    #notify(event) {
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch {
                // A view subscriber cannot affect indexing or import state.
            }
        }
    }
}

function normalizedIdentifiers(reference) {
    const value = reference?.identifiers || reference || {};
    return {
        doi: normalizeDOI(value.doi),
        arxivID: normalizeArxivID(value.arxivID),
        pmid: normalizePMID(value.pmid),
        pdfURL: normalizePDFURL(value.pdfURL),
    };
}

function firstIdentifier(identifiers) {
    for (const type of RELIABLE_IDENTIFIER_TYPES) {
        if (identifiers[type]) return { type, value: identifiers[type] };
    }
    return { type: '', value: '' };
}

function hasReliableIdentifier(identifiers) {
    return RELIABLE_IDENTIFIER_TYPES.some(type => Boolean(identifiers[type]));
}

function normalizePMID(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return /^\d{1,12}$/u.test(normalized) ? normalized : '';
}

function normalizePDFURL(value) {
    if (typeof value !== 'string' || value.length > MAX_PDF_URL_LENGTH) {
        return '';
    }
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

function firstTranslatedItemID(items) {
    if (!Array.isArray(items)) return null;
    const item = items.find(value => value?.isRegularItem?.() || value?.id);
    return item?.id ?? null;
}

function failedResult(
    reference,
    targetLibraryID,
    errorCode,
    { canImport } = {}
) {
    return {
        status: 'failed',
        state: 'failed',
        referenceID: reference?.id || '',
        targetLibraryID,
        identifiers: normalizedIdentifiers(reference),
        selectedMatches: [],
        otherMatches: [],
        errorCode,
        canImport,
        retryable: true,
    };
}

function safeErrorCode(error, fallback) {
    if (typeof error?.code === 'string'
        && /^REFERENCE_[A-Z0-9_]+$/u.test(error.code)) {
        return error.code;
    }
    const providerCode = String(error?.code || '');
    if (/(?:NETWORK|TIMEOUT|RATE|HTTP_ERROR)/u.test(providerCode)) {
        return 'REFERENCE_NETWORK_FAILED';
    }
    return fallback;
}

function referenceError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
