import { translateEnglish } from '../i18n/localization.js';
import {
    AI_MAX_OUTPUT_TOKENS,
    AI_MAX_REQUEST_TIMEOUT_MS,
} from './ai-preferences.js';

export const MINERU_API_KEY_PREF = 'extensions.mktero.mineruApiKey';
export const MINERU_CACHE_ENABLED_PREF = 'extensions.mktero.cacheEnabled';
export const MINERU_PREFERENCE_PANE_ID = 'mktero-preferences';

export const PREFERENCE_CONTROL_LIMITS = Object.freeze({
    aiRequestTimeoutMs: AI_MAX_REQUEST_TIMEOUT_MS,
    aiMaxOutputTokens: AI_MAX_OUTPUT_TOKENS,
});

export function getZoteroLocale(zotero, services) {
    return String(
        zotero?.locale
        || services?.locale?.appLocaleAsBCP47
        || ''
    );
}

export function getMinerUApiKey(zotero) {
    return String(zotero.Prefs.get(MINERU_API_KEY_PREF, true) || '').trim();
}

export function getMinerUCacheEnabled(zotero) {
    return zotero.Prefs.get(MINERU_CACHE_ENABLED_PREF, true) !== false;
}

export function registerMinerUPreferencesPane({
    zotero,
    pluginID,
    rootURI,
    translate = translateEnglish,
}) {
    if (!zotero.PreferencePanes?.register) {
        throw new Error(translate('error.preferencesUnavailable'));
    }
    return zotero.PreferencePanes.register({
        pluginID,
        id: MINERU_PREFERENCE_PANE_ID,
        label: 'Mktero',
        image: `${rootURI}ui/icons/mktero.svg`,
        src: `${rootURI}ui/preferences.xhtml`,
        scripts: [`${rootURI}ui/preferences.js`],
        stylesheets: [`${rootURI}ui/preferences.css`],
        helpURL: 'https://mineru.net/apiManage/docs',
    });
}

export function openMinerUPreferences(zotero) {
    zotero.Utilities?.Internal?.openPreferences?.(MINERU_PREFERENCE_PANE_ID);
}
