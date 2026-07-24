import { createMarkdownTabView } from './markdown-window.js';

const TAB_TYPE = 'mktero';

export class MarkdownTabPresenter {
    constructor({ zotero, rootURI, createView = createMarkdownTabView }) {
        this.zotero = zotero;
        this.rootURI = rootURI;
        this.createView = createView;
        this.presentations = new Map();
        this.sessionStatePatch = null;
        this.removeStaleSessionTabs();
        this.ensureSessionStateFilter();
    }

    open(itemID, { onClose, onReparse } = {}) {
        this.ensureSessionStateFilter();
        const owner = this.zotero.getMainWindow?.();
        const tabs = owner?.Zotero_Tabs;
        if (!owner?.document || !tabs?.add || !tabs?.select) {
            throw new Error('The Zotero tab manager is not available');
        }

        const existing = this.presentations.get(itemID);
        if (existing) {
            if (onClose) existing.onClose = onClose;
            if (onReparse) existing.model.onReparse = onReparse;
            tabs.select(existing.tabID);
            return { ...existing, created: false };
        }

        const model = createInitialModel(itemID, onReparse);
        const view = this.createView({
            document: owner.document,
            rootURI: this.rootURI,
            model,
            zotero: this.zotero,
        });
        view.render(model);
        let presentation;
        let tabID;
        try {
            const result = tabs.add({
                type: TAB_TYPE,
                title: model.title,
                data: {
                    mkteroItemID: itemID,
                    icon: 'attachment-pdf',
                },
                select: true,
                preventJumpback: true,
                onClose: () => {
                    if (presentation) presentation.closed = true;
                    presentation?.view.destroy?.();
                    if (this.presentations.get(itemID)?.tabID === tabID) {
                        this.presentations.delete(itemID);
                    }
                    try {
                        presentation?.onClose?.();
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
            tabs,
            tabID,
            view,
            model,
            closed: false,
            onClose,
        };
        this.presentations.set(itemID, presentation);

        this.debug(`Opened inline Markdown view for item ${itemID}`);

        return { ...presentation, created: true };
    }

    update(presentation, changes) {
        const current = this.presentations.get(presentation.model.itemID);
        if (!current || current.tabID !== presentation.tabID || current.closed) return;

        Object.assign(current.model, changes);
        if (typeof changes.title === 'string' && changes.title) {
            current.tabs.rename?.(current.tabID, changes.title);
        }
        current.view.render(current.model);
    }

    closeAll() {
        for (const presentation of [...this.presentations.values()]) {
            if (!presentation.closed) presentation.tabs.close?.(presentation.tabID);
        }
        this.presentations.clear();
    }

    dispose() {
        this.closeAll();
        this.restoreSessionStateFilter();
    }

    ensureSessionStateFilter() {
        const owner = this.zotero.getMainWindow?.();
        const tabs = owner?.Zotero_Tabs;
        if (!tabs?.getState) return;
        if (this.sessionStatePatch?.tabs === tabs) return;

        this.restoreSessionStateFilter();
        const originalGetState = tabs.getState;
        const filteredGetState = function filteredGetState() {
            const state = originalGetState.call(this);
            if (!Array.isArray(state)) return state;
            return state.filter(tab => !isMkteroSessionTab(tab));
        };
        tabs.getState = filteredGetState;
        this.sessionStatePatch = { tabs, originalGetState, filteredGetState };
    }

    restoreSessionStateFilter() {
        const patch = this.sessionStatePatch;
        if (!patch) return;
        if (patch.tabs.getState === patch.filteredGetState) {
            patch.tabs.getState = patch.originalGetState;
        }
        this.sessionStatePatch = null;
    }

    debug(message) {
        this.zotero.debug?.(`Mktero: ${message}`);
    }

    removeStaleSessionTabs() {
        const windows = this.zotero.Session?.state?.windows;
        if (!Array.isArray(windows)) return;

        for (const windowState of windows) {
            if (!Array.isArray(windowState.tabs)) continue;
            windowState.tabs = windowState.tabs.filter(tab => !isMkteroSessionTab(tab));
        }
    }
}

function isMkteroSessionTab(tab) {
    return tab?.type === TAB_TYPE && tab.data?.mkteroItemID !== undefined;
}

function createInitialModel(itemID, onReparse) {
    return {
        itemID,
        title: 'Converting PDF…',
        status: 'loading',
        progress: 0,
        markdown: '',
        assets: [],
        assetBasePath: '',
        sourceKind: null,
        cacheHit: false,
        preserveContent: false,
        warnings: [],
        error: '',
        onReparse,
    };
}
