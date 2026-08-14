import {
    isSupportedAITargetLanguage,
} from '../config/ai-preferences.js';

export function normalizeTranslationPresentation(value = {}) {
    const language = String(value?.language || '').trim();
    const sourceFallback = Boolean(value?.sourceFallback);
    return Object.freeze({
        language: !sourceFallback && isSupportedAITargetLanguage(language)
            ? language
            : '',
        sourceFallback,
    });
}

export function sameTranslationPresentation(left, right) {
    return left?.language === right?.language
        && left?.sourceFallback === right?.sourceFallback;
}

export function applyTranslationPresentation(element, value) {
    const presentation = normalizeTranslationPresentation(value);
    if (presentation.language) {
        element.classList.add('cm-mktero-translation-block');
        element.setAttribute('lang', presentation.language);
    }
    if (presentation.sourceFallback) {
        element.classList.add('cm-mktero-translation-failure-block');
    }
}
