import {
    createBundledHighlighter,
    createSingletonShorthands,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

const MAX_HIGHLIGHTED_CODE_LENGTH = 50_000;
const MAX_HIGHLIGHTED_CODE_LINES = 5_000;
const MAX_TOKENIZE_LINE_LENGTH = 500;
const TOKENIZE_TIME_LIMIT = 100;
const MAX_CACHE_ENTRIES = 120;

const plainTextLanguages = new Set([
    '',
    'plain',
    'plaintext',
    'text',
    'txt',
]);

const languageAliases = new Map([
    ['bash', 'shell'],
    ['c', 'cpp'],
    ['c++', 'cpp'],
    ['cc', 'cpp'],
    ['cjs', 'javascript'],
    ['conf', 'ini'],
    ['h', 'cpp'],
    ['hpp', 'cpp'],
    ['ipynb', 'json'],
    ['js', 'javascript'],
    ['jsx', 'javascript'],
    ['mjs', 'javascript'],
    ['md', 'markdown'],
    ['ps1', 'powershell'],
    ['py', 'python'],
    ['rs', 'rust'],
    ['sh', 'shell'],
    ['shellscript', 'shell'],
    ['ts', 'typescript'],
    ['tsx', 'typescript'],
    ['yml', 'yaml'],
    ['zsh', 'shell'],
]);

const shikiLanguageLoaders = {
    cpp: () => import('shiki/langs/cpp.mjs'),
    css: () => import('shiki/langs/css.mjs'),
    diff: () => import('shiki/langs/diff.mjs'),
    dockerfile: () => import('shiki/langs/dockerfile.mjs'),
    go: () => import('shiki/langs/go.mjs'),
    hcl: () => import('shiki/langs/hcl.mjs'),
    html: () => import('shiki/langs/html.mjs'),
    ini: () => import('shiki/langs/ini.mjs'),
    java: () => import('shiki/langs/java.mjs'),
    javascript: () => import('shiki/langs/javascript.mjs'),
    json: () => import('shiki/langs/json.mjs'),
    julia: () => import('shiki/langs/julia.mjs'),
    kotlin: () => import('shiki/langs/kotlin.mjs'),
    lua: () => import('shiki/langs/lua.mjs'),
    markdown: () => import('shiki/langs/markdown.mjs'),
    matlab: () => import('shiki/langs/matlab.mjs'),
    powershell: () => import('shiki/langs/powershell.mjs'),
    python: () => import('shiki/langs/python.mjs'),
    r: () => import('shiki/langs/r.mjs'),
    ruby: () => import('shiki/langs/ruby.mjs'),
    rust: () => import('shiki/langs/rust.mjs'),
    scala: () => import('shiki/langs/scala.mjs'),
    shell: () => import('shiki/langs/shell.mjs'),
    sql: () => import('shiki/langs/sql.mjs'),
    typescript: () => import('shiki/langs/typescript.mjs'),
    xml: () => import('shiki/langs/xml.mjs'),
    yaml: () => import('shiki/langs/yaml.mjs'),
};

const shikiThemeLoaders = {
    'vitesse-dark': () => import('shiki/themes/vitesse-dark.mjs'),
    'vitesse-light': () => import('shiki/themes/vitesse-light.mjs'),
};

const createMarkdownCodeHighlighter = createBundledHighlighter({
    langs: shikiLanguageLoaders,
    themes: shikiThemeLoaders,
    engine: createJavaScriptRegexEngine,
});
const { codeToTokens } = createSingletonShorthands(
    createMarkdownCodeHighlighter
);

const highlightCache = new Map();

export function normalizeCodeBlockLanguage(language) {
    const normalized = String(language || '')
        .trim()
        .toLowerCase()
        .replace(/^language-/, '')
        .split(/[\s,]+/, 1)[0];
    return languageAliases.get(normalized) || normalized || 'text';
}

export function shouldHighlightCodeBlock(code, language) {
    const normalizedLanguage = normalizeCodeBlockLanguage(language);
    return typeof code === 'string'
        && code.length > 0
        && code.length <= MAX_HIGHLIGHTED_CODE_LENGTH
        && code.split('\n').length <= MAX_HIGHLIGHTED_CODE_LINES
        && !plainTextLanguages.has(normalizedLanguage)
        && Object.hasOwn(shikiLanguageLoaders, normalizedLanguage);
}

export async function highlightCodeBlock({
    code,
    language,
    theme = 'light',
}) {
    const normalizedLanguage = normalizeCodeBlockLanguage(language);
    const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
    if (!shouldHighlightCodeBlock(code, normalizedLanguage)) return null;

    const cacheKey = [normalizedTheme, normalizedLanguage, code].join('\0');
    const cached = highlightCache.get(cacheKey);
    if (cached) return cached;

    const promise = Promise.resolve()
        .then(() => codeToTokens(code, {
            lang: normalizedLanguage,
            theme: normalizedTheme === 'dark'
                ? 'vitesse-dark'
                : 'vitesse-light',
            tokenizeMaxLineLength: MAX_TOKENIZE_LINE_LENGTH,
            tokenizeTimeLimit: TOKENIZE_TIME_LIMIT,
        }))
        .then(result => ({
            language: normalizedLanguage,
            theme: normalizedTheme,
            lines: result.tokens.map(line => line.map(token => ({
                content: token.content,
                color: token.color,
                fontStyle: token.fontStyle,
                offset: token.offset,
            }))),
        }))
        .catch(() => null);

    if (highlightCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = highlightCache.keys().next().value;
        if (oldestKey) highlightCache.delete(oldestKey);
    }
    highlightCache.set(cacheKey, promise);
    return promise;
}
