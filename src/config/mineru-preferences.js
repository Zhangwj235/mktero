export const MINERU_API_KEY_PREF = 'extensions.mktero.mineruApiKey';
export const MINERU_CACHE_ENABLED_PREF = 'extensions.mktero.cacheEnabled';
export const MKTERO_PROXY_ENABLED_PREF = 'extensions.mktero.proxyEnabled';
export const MKTERO_PROXY_USE_SYSTEM_PREF = 'extensions.mktero.proxyUseSystem';
export const MKTERO_PROXY_URL_PREF = 'extensions.mktero.proxyURL';
export const MKTERO_PROXY_BYPASS_PREF = 'extensions.mktero.proxyBypass';
export const MINERU_PREFERENCE_PANE_ID = 'mktero-preferences';

export function getMinerUApiKey(zotero) {
    return String(zotero.Prefs.get(MINERU_API_KEY_PREF, true) || '').trim();
}

export function getMinerUCacheEnabled(zotero) {
    return zotero.Prefs.get(MINERU_CACHE_ENABLED_PREF, true) !== false;
}

export function getMkteroProxyConfig(zotero) {
    return {
        enabled: zotero.Prefs.get(MKTERO_PROXY_ENABLED_PREF, true) === true,
        useSystem: zotero.Prefs.get(MKTERO_PROXY_USE_SYSTEM_PREF, true) !== false,
        url: String(zotero.Prefs.get(MKTERO_PROXY_URL_PREF, true) || '').trim(),
        bypass: String(zotero.Prefs.get(MKTERO_PROXY_BYPASS_PREF, true) || '').trim(),
    };
}

export function registerMinerUPreferencesPane({ zotero, pluginID, rootURI }) {
    if (!zotero.PreferencePanes?.register) {
        throw new Error('Zotero preference panes are unavailable');
    }
    return zotero.PreferencePanes.register({
        pluginID,
        id: MINERU_PREFERENCE_PANE_ID,
        label: 'Mktero',
        src: `${rootURI}ui/preferences.xhtml`,
        scripts: [`${rootURI}ui/preferences.js`],
        stylesheets: [`${rootURI}ui/preferences.css`],
        helpURL: 'https://mineru.net/apiManage/docs',
    });
}

export function openMinerUPreferences(zotero) {
    zotero.Utilities?.Internal?.openPreferences?.(MINERU_PREFERENCE_PANE_ID);
}
