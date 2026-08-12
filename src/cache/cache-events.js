export const LOCAL_CACHE_CLEARED_TOPIC = 'mktero-cache-cleared';

export function notifyLocalCacheCleared(services) {
    services?.obs?.notifyObservers?.(null, LOCAL_CACHE_CLEARED_TOPIC);
}

export function withSuccessfulClearNotification(cache, listener) {
    if (typeof cache?.getStats !== 'function'
        || typeof cache?.clear !== 'function'
        || typeof listener !== 'function') {
        throw new TypeError('A cache and clear listener are required');
    }
    return {
        getStats: (...args) => cache.getStats(...args),
        async clear(...args) {
            await cache.clear(...args);
            listener();
        },
    };
}

export function observeLocalCacheCleared(services, listener) {
    if (typeof listener !== 'function') {
        throw new TypeError('A local cache listener is required');
    }
    if (!services?.obs?.addObserver || !services?.obs?.removeObserver) {
        return () => {};
    }
    const observer = {
        observe(_subject, topic) {
            if (topic === LOCAL_CACHE_CLEARED_TOPIC) listener();
        },
    };
    services.obs.addObserver(observer, LOCAL_CACHE_CLEARED_TOPIC);
    return () => services.obs.removeObserver(
        observer,
        LOCAL_CACHE_CLEARED_TOPIC
    );
}
