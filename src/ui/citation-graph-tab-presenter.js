import { createRuntimeAbortController } from '../platform/abort-controller.js';
import { createLocalization } from '../i18n/localization.js';
import { createCitationGraphView } from './citation-graph-window.js';
import {
    installMkteroSessionStateFilter,
    removeStaleMkteroSessionTabs,
} from './mktero-session-tabs.js';

const TAB_TYPE = 'mktero';
const TAB_ICON = 'citation-graph';
const TAB_ICON_STYLE_ID = 'mktero-citation-graph-tab-icon-style';
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export const CITATION_GRAPH_TAB_CLOSE_REASONS = Object.freeze({
    USER: 'user',
    SHUTDOWN: 'shutdown',
});

export class CitationGraphTabPresenter {
    constructor({
        zotero,
        rootURI,
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
        this.rootURI = rootURI;
        this.graph = graph;
        this.library = library;
        this.onOpenPaper = typeof onOpenPaper === 'function'
            ? onOpenPaper
            : node => this.library.openPaper(node);
        this.getLibraryName = getLibraryName;
        this.createView = createView;
        this.createAbortController = createAbortController;
        this.localization = localization;
        this.presentations = new Map();
        this.sessionStateTabs = null;
        this.disposeSessionStateFilter = null;
        this.tabIconStyles = new Set();
        removeStaleMkteroSessionTabs(zotero);
        this.ensureSessionStateFilter();
    }

    open(libraryID, {
        focusItemID = null,
        forceRefresh = false,
        onClose = null,
    } = {}) {
        this.ensureSessionStateFilter();
        const key = String(libraryID);
        const existing = this.presentations.get(key);
        if (existing && !existing.closed) {
            existing.focusItemID = focusItemID;
            existing.onClose = onClose || existing.onClose;
            existing.tabs.select?.(existing.tabID);
            if (focusItemID !== null && focusItemID !== undefined) {
                existing.view.focus?.(focusItemID);
                existing.lastFocusedItemID = focusItemID;
            }
            if (forceRefresh) {
                existing.refreshPromise = this.refresh(existing, {
                    forceRefresh: true,
                });
            }
            return existing;
        }

        const owner = this.zotero.getMainWindow?.();
        const tabs = owner?.Zotero_Tabs;
        if (!owner?.document || !tabs?.add || !tabs?.select) {
            throw new Error(this.message('error.tabManagerUnavailable'));
        }
        this.ensureTabIconStyle(owner.document);
        const libraryName = this.safeLibraryName(libraryID);
        const view = this.createView({
            document: owner.document,
            localization: this.localization,
            onRefresh: () => {
                const current = this.presentations.get(key);
                if (!current || current.closed) return;
                current.refreshPromise = this.refresh(current, {
                    forceRefresh: true,
                });
            },
            onOpenPaper: node => this.onOpenPaper(node),
            onError: error => this.zotero.logError?.(error),
        });
        let presentation;
        let tabID;
        try {
            const result = tabs.add({
                type: TAB_TYPE,
                title: this.tabTitle(libraryName),
                data: {
                    mkteroCitationLibraryID: libraryID,
                    icon: TAB_ICON,
                },
                select: true,
                preventJumpback: true,
                onClose: () => {
                    if (!presentation || presentation.closed) return;
                    const reason = presentation.closeReason
                        || CITATION_GRAPH_TAB_CLOSE_REASONS.USER;
                    presentation.closed = true;
                    presentation.closeReason = null;
                    presentation.controller?.abort?.();
                    presentation.controller = null;
                    presentation.view.destroy?.();
                    if (this.presentations.get(key)?.tabID === tabID) {
                        this.presentations.delete(key);
                    }
                    try {
                        presentation.onClose?.({ reason });
                    }
                    catch (error) {
                        this.zotero.logError?.(error);
                    }
                },
            });
            tabID = result.id;
            result.container.appendChild(view.root);
        }
        catch (error) {
            view.destroy?.();
            if (tabID) tabs.close?.(tabID);
            throw error;
        }
        presentation = {
            libraryID,
            libraryName,
            focusItemID,
            owner,
            tabs,
            tabID,
            view,
            snapshot: null,
            lastFocusedItemID: null,
            controller: null,
            refreshPromise: null,
            closed: false,
            closeReason: null,
            onClose,
        };
        this.presentations.set(key, presentation);
        tabs.select(tabID);
        this.update(presentation, loadingSnapshot(presentation));
        presentation.refreshPromise = this.refresh(presentation, {
            forceRefresh,
        });
        return presentation;
    }

    async refresh(presentation, { forceRefresh = false } = {}) {
        if (!this.isLive(presentation)) return null;
        presentation.controller?.abort?.();
        const controller = this.createAbortController();
        presentation.controller = controller;
        const focusItemID = presentation.focusItemID;
        const pendingProgress = [];
        let initialRendered = false;
        try {
            const operation = await this.graph.getLibraryGraph({
                libraryID: presentation.libraryID,
                focusItemID,
                forceRefresh,
                signal: controller.signal,
                onProgress: snapshot => {
                    if (!initialRendered) {
                        pendingProgress.push(snapshot);
                    }
                    else if (this.isCurrentRequest(presentation, controller)) {
                        this.update(presentation, snapshot);
                    }
                },
            });
            if (!this.isCurrentRequest(presentation, controller)) return null;
            this.update(presentation, operation.snapshot);
            initialRendered = true;
            for (const snapshot of pendingProgress) {
                if (!this.isCurrentRequest(presentation, controller)) return null;
                this.update(presentation, snapshot);
            }
            const finalSnapshot = await operation.completion;
            if (!this.isCurrentRequest(presentation, controller)) return null;
            this.update(presentation, finalSnapshot);
            return finalSnapshot;
        }
        catch (error) {
            if (controller.signal?.aborted || error?.name === 'AbortError') return null;
            this.zotero.logError?.(error);
            if (this.isCurrentRequest(presentation, controller)) {
                this.update(presentation, {
                    ...(presentation.snapshot || emptySnapshot(presentation)),
                    status: 'error',
                    error: this.message('graph.loadFailed'),
                });
            }
            return null;
        }
        finally {
            if (presentation.controller === controller) {
                presentation.controller = null;
            }
        }
    }

    update(presentation, snapshot) {
        if (!this.isLive(presentation) || !snapshot) return;
        const focusedSnapshot = {
            ...snapshot,
            libraryID: presentation.libraryID,
            libraryName: presentation.libraryName,
            selectedItemID: presentation.focusItemID
                ?? snapshot.selectedItemID
                ?? null,
        };
        presentation.snapshot = focusedSnapshot;
        presentation.view.render(focusedSnapshot);
        if (presentation.focusItemID !== null
            && presentation.focusItemID !== undefined
            && String(presentation.lastFocusedItemID)
                !== String(presentation.focusItemID)) {
            presentation.view.focus?.(presentation.focusItemID);
            presentation.lastFocusedItemID = presentation.focusItemID;
        }
    }

    get(libraryID) {
        return this.presentations.get(String(libraryID)) || null;
    }

    closeForWindow(window) {
        for (const presentation of [...this.presentations.values()]) {
            if (presentation.owner !== window || presentation.closed) continue;
            presentation.tabs.close?.(presentation.tabID);
        }
    }

    dispose() {
        for (const presentation of [...this.presentations.values()]) {
            if (presentation.closed) continue;
            presentation.closeReason = CITATION_GRAPH_TAB_CLOSE_REASONS.SHUTDOWN;
            presentation.tabs.close?.(presentation.tabID);
        }
        this.presentations.clear();
        this.restoreSessionStateFilter();
        for (const style of this.tabIconStyles) style.remove?.();
        this.tabIconStyles.clear();
    }

    isLive(presentation) {
        return Boolean(presentation
            && !presentation.closed
            && this.presentations.get(String(presentation.libraryID)) === presentation);
    }

    isCurrentRequest(presentation, controller) {
        return this.isLive(presentation)
            && presentation.controller === controller
            && !controller.signal?.aborted;
    }

    ensureSessionStateFilter() {
        const tabs = this.zotero.getMainWindow?.()?.Zotero_Tabs;
        if (!tabs?.getState || tabs === this.sessionStateTabs) return;
        this.restoreSessionStateFilter();
        this.disposeSessionStateFilter = installMkteroSessionStateFilter(tabs);
        this.sessionStateTabs = tabs;
    }

    restoreSessionStateFilter() {
        this.disposeSessionStateFilter?.();
        this.disposeSessionStateFilter = null;
        this.sessionStateTabs = null;
    }

    ensureTabIconStyle(document) {
        const existing = document.getElementById?.(TAB_ICON_STYLE_ID);
        if (existing) {
            this.tabIconStyles.add(existing);
            return;
        }
        if (!document.createElementNS || !document.documentElement?.appendChild) return;
        const style = document.createElementNS(XHTML_NAMESPACE, 'style');
        style.setAttribute('id', TAB_ICON_STYLE_ID);
        style.textContent = `
.icon-item-type[data-item-type="${TAB_ICON}"] {
    background-image: url("${this.rootURI}ui/icons/mktero.svg") !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    background-size: contain !important;
}
`;
        document.documentElement.appendChild(style);
        this.tabIconStyles.add(style);
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

    tabTitle(libraryName) {
        return this.message('graph.tabTitle', { library: libraryName });
    }

    message(key, variables) {
        return this.localization.t(key, variables);
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
