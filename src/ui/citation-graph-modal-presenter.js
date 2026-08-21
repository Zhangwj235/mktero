import { createRuntimeAbortController } from '../platform/abort-controller.js';
import { createLocalization } from '../i18n/localization.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
import { scopeCitationGraphSnapshot } from '../citations/citation-graph-scope.js';
import { createCitationGraphView } from './citation-graph-window.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MODAL_HOST_CLASS = 'mktero-citation-graph-modal-host';

const MODAL_STYLES = `
:host,
:host *,
:host *::before,
:host *::after {
    box-sizing: border-box;
}

:host {
    position: fixed;
    inset: 0;
    z-index: 100000;
    display: block;
    color-scheme: light dark;
    font: menu;
}

.citation-graph-modal-backdrop {
    display: grid;
    width: 100%;
    height: 100%;
    padding: clamp(18px, 4vh, 48px) clamp(18px, 4vw, 64px);
    background: rgb(20 27 36 / 46%);
    place-items: center;
}

.citation-graph-modal-dialog {
    display: flex;
    width: min(1120px, 100%);
    height: min(720px, 100%);
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--mktero-modal-border, #cbd5e1);
    border-radius: 10px;
    background: var(--mktero-modal-surface, #ffffff);
    box-shadow: 0 24px 80px rgb(0 0 0 / 32%);
}

.citation-graph-modal-header {
    display: flex;
    min-height: 44px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px 8px 18px;
    border-bottom: 1px solid var(--mktero-modal-border, #cbd5e1);
    color: var(--mktero-modal-text, #202124);
    background: var(--mktero-modal-surface, #ffffff);
    font: 600 14px/1.3 system-ui, sans-serif;
}

.citation-graph-modal-close {
    display: grid;
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
    place-items: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--mktero-modal-muted, #64748b);
    background: transparent;
    cursor: pointer;
}

.citation-graph-modal-close:hover,
.citation-graph-modal-close:focus-visible {
    border-color: var(--mktero-modal-border, #cbd5e1);
    color: var(--mktero-modal-text, #202124);
    background: rgb(100 116 139 / 10%);
}

.citation-graph-modal-close:focus-visible {
    outline: 2px solid var(--mktero-modal-accent, #3567c8);
    outline-offset: 1px;
}

.citation-graph-modal-body {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
}

.citation-graph-modal-body > .citation-graph-host {
    width: 100%;
    height: 100%;
}

@media (prefers-color-scheme: dark) {
    .citation-graph-modal-dialog,
    .citation-graph-modal-header {
        --mktero-modal-border: #424a55;
        --mktero-modal-surface: #24282e;
        --mktero-modal-text: #edf1f5;
        --mktero-modal-muted: #aab2bc;
        --mktero-modal-accent: #8fb4ff;
    }
}

@media (prefers-reduced-motion: reduce) {
    .citation-graph-modal-backdrop { transition: none; }
}
`;

export class CitationGraphModalPresenter {
    constructor({
        zotero,
        graph,
        library,
        onOpenPaper = null,
        getLibraryName = libraryID => String(libraryID),
        createView = createCitationGraphView,
        createAbortController = createRuntimeAbortController,
        localization = createLocalization(),
    }) {
        if (typeof graph?.getLibraryGraph !== 'function') {
            throw new TypeError('A citation graph service is required');
        }
        if (typeof library?.openPaper !== 'function') {
            throw new TypeError('A citation library adapter is required');
        }
        this.zotero = zotero;
        this.graph = graph;
        this.library = library;
        this.onOpenPaper = typeof onOpenPaper === 'function'
            ? onOpenPaper
            : node => this.library.openPaper(node);
        this.getLibraryName = getLibraryName;
        this.createView = createView;
        this.createAbortController = createAbortController;
        this.localization = localization;
        this.presentation = null;
    }

    open({
        libraryID,
        focusItemID,
        sourceItemID = focusItemID,
        forceRefresh = false,
    } = {}) {
        const owner = this.zotero.getMainWindow?.();
        if (!owner?.document?.createElementNS) {
            throw new Error(this.message('error.tabManagerUnavailable'));
        }
        this.close();

        const document = owner.document;
        const previousFocus = document.activeElement;
        const host = document.createElementNS(XHTML_NAMESPACE, 'div');
        host.className = MODAL_HOST_CLASS;
        if (!host.attachShadow) {
            throw new Error(this.message('error.citationGraphViewUnavailable'));
        }
        const mount = host.attachShadow({ mode: 'open' });
        const style = document.createElementNS(XHTML_NAMESPACE, 'style');
        style.textContent = MODAL_STYLES;
        mount.appendChild(style);

        const backdrop = this.element(document, 'div', 'citation-graph-modal-backdrop');
        const dialog = this.element(document, 'div', 'citation-graph-modal-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'mktero-citation-graph-modal-title');
        const header = this.element(document, 'header', 'citation-graph-modal-header');
        const title = this.element(
            document,
            'strong',
            'citation-graph-modal-title',
            this.message('graph.modalTitle')
        );
        title.id = 'mktero-citation-graph-modal-title';
        const closeButton = this.element(document, 'button', 'citation-graph-modal-close');
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', this.message('graph.close'));
        closeButton.title = this.message('graph.close');
        closeButton.appendChild(createLucideIcon(document, LUCIDE_ICONS.x, { size: 17 }));
        header.append(title, closeButton);
        const body = this.element(document, 'div', 'citation-graph-modal-body');
        const libraryName = this.safeLibraryName(libraryID);
        const view = this.createView({
            document,
            localization: this.localization,
            onRefresh: () => {
                if (this.presentation) {
                    this.presentation.refreshPromise = this.refresh(
                        this.presentation,
                        { forceRefresh: true }
                    );
                }
            },
            onOpenPaper: node => this.onOpenPaper(node),
            onError: error => this.zotero.logError?.(error),
        });
        body.appendChild(view.root);
        dialog.append(header, body);
        backdrop.appendChild(dialog);
        mount.appendChild(backdrop);
        document.documentElement.appendChild(host);

        const presentation = {
            owner,
            document,
            host,
            backdrop,
            dialog,
            closeButton,
            view,
            libraryID,
            focusItemID,
            sourceItemID,
            libraryName,
            previousFocus,
            controller: null,
            refreshPromise: null,
            closed: false,
        };
        this.presentation = presentation;
        view.resize?.();
        const close = () => this.close();
        closeButton.addEventListener('click', close);
        backdrop.addEventListener('click', event => {
            if (event.target === backdrop) close();
        });
        owner.addEventListener?.('keydown', presentation.escape = event => {
            if (event.key === 'Escape') close();
        }, true);
        closeButton.focus?.();
        this.update(presentation, loadingSnapshot(presentation));
        presentation.refreshPromise = this.refresh(presentation, { forceRefresh });
        return presentation;
    }

    async refresh(presentation, { forceRefresh = false } = {}) {
        if (!this.isLive(presentation)) return null;
        presentation.controller?.abort?.();
        const controller = this.createAbortController();
        presentation.controller = controller;
        let initialRendered = false;
        const pending = [];
        try {
            const operation = await this.graph.getLibraryGraph({
                libraryID: presentation.libraryID,
                focusItemID: presentation.focusItemID,
                forceRefresh,
                signal: controller.signal,
                onProgress: snapshot => {
                    const scoped = scopeCitationGraphSnapshot(
                        snapshot,
                        presentation.focusItemID
                    );
                    if (!initialRendered) pending.push(scoped);
                    else if (this.isCurrentRequest(presentation, controller)) {
                        this.update(presentation, scoped);
                    }
                },
            });
            if (!this.isCurrentRequest(presentation, controller)) return null;
            this.update(
                presentation,
                scopeCitationGraphSnapshot(
                    operation.snapshot,
                    presentation.focusItemID
                )
            );
            initialRendered = true;
            for (const snapshot of pending) {
                if (!this.isCurrentRequest(presentation, controller)) return null;
                this.update(presentation, snapshot);
            }
            const finalSnapshot = await operation.completion;
            if (!this.isCurrentRequest(presentation, controller)) return null;
            const scoped = scopeCitationGraphSnapshot(
                finalSnapshot,
                presentation.focusItemID
            );
            this.update(presentation, scoped);
            return scoped;
        }
        catch (error) {
            if (controller.signal?.aborted || error?.name === 'AbortError') return null;
            this.zotero.logError?.(error);
            if (this.isCurrentRequest(presentation, controller)) {
                this.update(presentation, {
                    ...emptySnapshot(presentation),
                    status: 'error',
                    error: this.message('graph.loadFailed'),
                });
            }
            return null;
        }
        finally {
            if (presentation.controller === controller) presentation.controller = null;
        }
    }

    update(presentation, snapshot) {
        if (!this.isLive(presentation)) return;
        presentation.snapshot = {
            ...snapshot,
            libraryID: presentation.libraryID,
            libraryName: presentation.libraryName,
            selectedItemID: presentation.focusItemID,
        };
        presentation.view.render(presentation.snapshot);
    }

    closeForWindow(window) {
        if (this.presentation?.owner === window) this.close();
    }

    closeForItem(itemID) {
        if (this.presentation
            && (
                String(this.presentation.focusItemID) === String(itemID)
                || String(this.presentation.sourceItemID) === String(itemID)
            )) {
            this.close();
        }
    }

    close() {
        const presentation = this.presentation;
        if (!presentation || presentation.closed) return;
        presentation.closed = true;
        presentation.controller?.abort?.();
        presentation.controller = null;
        presentation.owner.removeEventListener?.(
            'keydown',
            presentation.escape,
            true
        );
        presentation.view.destroy?.();
        presentation.host.remove?.();
        presentation.previousFocus?.focus?.();
        this.presentation = null;
    }

    dispose() {
        this.close();
    }

    isLive(presentation) {
        return Boolean(
            presentation
            && !presentation.closed
            && this.presentation === presentation
        );
    }

    isCurrentRequest(presentation, controller) {
        return this.isLive(presentation)
            && presentation.controller === controller
            && !controller.signal?.aborted;
    }

    safeLibraryName(libraryID) {
        try {
            return String(this.getLibraryName(libraryID) || '').trim()
                || this.message('graph.title');
        }
        catch {
            return this.message('graph.title');
        }
    }

    message(key, variables) {
        return this.localization.t(key, variables);
    }

    element(document, tagName, className, text = null) {
        const element = document.createElementNS(XHTML_NAMESPACE, tagName);
        if (className) element.className = className;
        if (text !== null) element.textContent = text;
        return element;
    }
}

function emptySnapshot(presentation) {
    return {
        libraryID: presentation.libraryID,
        libraryName: presentation.libraryName,
        nodes: [],
        edges: [],
        selectedItemID: presentation.focusItemID,
        status: 'error',
        progress: { completed: 0, total: 0, failed: 0 },
        warnings: [],
        fetchedAt: null,
    };
}

function loadingSnapshot(presentation) {
    return {
        ...emptySnapshot(presentation),
        status: 'loading',
        error: null,
    };
}
