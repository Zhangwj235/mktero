export function createRuntimeAbortController({
    globalObject = globalThis,
    zotero = globalObject?.Zotero,
    services = globalObject?.Services,
} = {}) {
    for (const resolveOwner of [
        () => globalObject,
        () => zotero?.getMainWindow?.(),
        () => services?.appShell?.hiddenDOMWindow,
    ]) {
        let Constructor = null;
        try {
            Constructor = resolveOwner()?.AbortController;
        }
        catch {
            continue;
        }
        if (typeof Constructor === 'function') {
            return new Constructor();
        }
    }
    throw new Error('AbortController is unavailable in the Zotero runtime');
}
