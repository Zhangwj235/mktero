const FILTERS = new WeakMap();

export function isMkteroSessionTab(tab) {
    return tab?.type === 'mktero' && (
        tab.data?.mkteroItemID !== undefined
        || tab.data?.mkteroCitationLibraryID !== undefined
    );
}

export function removeStaleMkteroSessionTabs(zotero) {
    const windows = zotero?.Session?.state?.windows;
    if (!Array.isArray(windows)) return;
    for (const windowState of windows) {
        if (!Array.isArray(windowState.tabs)) continue;
        windowState.tabs = windowState.tabs.filter(tab => !isMkteroSessionTab(tab));
    }
}

export function installMkteroSessionStateFilter(tabs) {
    if (!tabs?.getState) return () => {};
    let record = FILTERS.get(tabs);
    if (!record) {
        const originalGetState = tabs.getState;
        const filteredGetState = function filteredGetState() {
            const state = originalGetState.call(this);
            return Array.isArray(state)
                ? state.filter(tab => !isMkteroSessionTab(tab))
                : state;
        };
        record = {
            count: 0,
            originalGetState,
            filteredGetState,
        };
        FILTERS.set(tabs, record);
        tabs.getState = filteredGetState;
    }
    record.count++;
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        record.count--;
        if (record.count > 0) return;
        if (tabs.getState === record.filteredGetState) {
            tabs.getState = record.originalGetState;
        }
        FILTERS.delete(tabs);
    };
}
