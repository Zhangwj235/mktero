import { Marked } from 'marked';
import katex from 'katex';

const MAX_MATH_EXPRESSIONS = 1000;
const MAX_MATH_OUTPUT_LENGTH = 250_000;
const MAX_MATH_SOURCE_LENGTH = 10_000;
const MAX_TOTAL_MATH_OUTPUT_LENGTH = 1_000_000;
const MAX_TOTAL_MATH_SOURCE_LENGTH = 100_000;
const UNSAFE_MATH_COMMAND = /\\(?:csname|def|edef|futurelet|gdef|global|let|newcommand|providecommand|renewcommand|xdef)\b/;
const INLINE_CHILD_TOKEN_TYPES = new Set(['strong', 'em', 'del', 'link', 'image']);
const MATH_RANGE_TOKEN_TYPES = new Set(['text', 'escape', 'strong', 'em', 'del', 'link']);
const SAFE_TABLE_TAGS = new Set([
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'colgroup',
    'col',
    'p',
    'br',
    'strong',
    'em',
    'b',
    'i',
    'sub',
    'sup',
    'code',
]);

export function renderMarkdownHTML(markdown, { resolveImageURL = () => null } = {}) {
    if (typeof markdown !== 'string') {
        throw new TypeError('Markdown must be a string');
    }

    const renderer = createSafeRenderer(resolveImageURL);
    const mathBudget = createMathRenderBudget();
    const parser = new Marked({
        gfm: true,
        renderer,
        extensions: [
            createMathBlockExtension(mathBudget),
            createMathInlineExtension(mathBudget),
        ],
    });
    const tokens = parser.lexer(markdown);
    const transformedTokens = transformBlockTokens(tokens, parser.Lexer, parser.defaults, {
        links: tokens.links,
    });
    transformedTokens.links = tokens.links;
    return parser.parser(transformedTokens);
}

function createSafeRenderer(resolveImageURL) {
    return {
        html({ text }) {
            const page = text.trim().match(/^<!--\s*zotero-page:\s*(.*?)\s*-->$/);
            if (page) {
                return `<span class="page-marker" data-page="${escapeAttribute(page[1])}">Page ${escapeHTML(page[1])}</span>`;
            }
            const table = sanitizeRawHTMLTable(text);
            if (table) return table;
            return escapeKnownInlineTags(escapeHTML(text));
        },

        link({ href, tokens }) {
            const label = this.parser.parseInline(tokens);
            const safeHref = safeMarkdownLinkURL(href);
            if (!safeHref) return label;
            return `<a href="${escapeAttribute(safeHref)}" rel="noreferrer">${label}</a>`;
        },

        image({ href, title, text, tokens }) {
            const alt = tokens
                ? inlineTokensToText(tokens)
                : text;
            const resolved = resolveImageURL(href);
            if (!resolved || !String(resolved).startsWith('blob:')) {
                return `<span class="missing-image">${escapeHTML(alt || 'Image')}</span>`;
            }
            const titleAttribute = title
                ? ` title="${escapeAttribute(title)}"`
                : '';
            return `<img src="${escapeAttribute(resolved)}" alt="${escapeAttribute(alt)}"${titleAttribute}>`;
        },
    };
}

function createMathBlockExtension(mathBudget) {
    return {
        name: 'mkteroMathBlock',
        renderer(token) {
            const math = renderMathML(token.text, true, mathBudget);
            return `<div class="math math-display">${math}</div>\n`;
        },
    };
}

function createMathInlineExtension(mathBudget) {
    return {
        name: 'mkteroMathInline',
        renderer(token) {
            const math = renderMathML(token.text, false, mathBudget);
            return `<span class="math-inline">${math}</span>`;
        },
    };
}

function transformBlockTokens(tokens, Lexer, options, context) {
    const transformed = [];
    for (const token of tokens) {
        if (token.type === 'paragraph' || token.type === 'text') {
            const splitTokens = splitDisplayMathToken(
                token,
                Lexer,
                options,
                context
            );
            if (splitTokens) {
                appendTokens(transformed, splitTokens);
                continue;
            }
            token.tokens = transformInlineTokens(token.tokens, Lexer, options, context);
            transformed.push(token);
            continue;
        }
        if (token.type === 'heading') {
            token.tokens = transformInlineTokens(token.tokens, Lexer, options, context);
            transformed.push(token);
            continue;
        }
        if (token.type === 'blockquote') {
            token.tokens = transformBlockTokens(token.tokens, Lexer, options, context);
            transformed.push(token);
            continue;
        }
        if (token.type === 'list') {
            for (const item of token.items) {
                item.tokens = transformBlockTokens(
                    item.tokens,
                    Lexer,
                    options,
                    context
                );
            }
            transformed.push(token);
            continue;
        }
        if (token.type === 'table') {
            for (const cell of token.header) {
                cell.tokens = transformInlineTokens(
                    cell.tokens,
                    Lexer,
                    options,
                    context
                );
            }
            for (const row of token.rows) {
                for (const cell of row) {
                    cell.tokens = transformInlineTokens(
                        cell.tokens,
                        Lexer,
                        options,
                        context
                    );
                }
            }
        }
        transformed.push(token);
    }
    return transformed;
}

function splitDisplayMathToken(token, Lexer, options, context) {
    const source = token.text;
    const matches = findDisplayMathMatches(source);
    if (!matches.length) return null;

    const splitTokens = [];
    let sourceIndex = 0;
    for (const match of matches) {
        appendBlockFragment(
            splitTokens,
            source.slice(sourceIndex, match.start),
            token.type,
            Lexer,
            options,
            context
        );
        splitTokens.push({
            type: 'mkteroMathBlock',
            raw: match.raw,
            text: match.text,
        });
        sourceIndex = match.end;
    }
    appendBlockFragment(
        splitTokens,
        source.slice(sourceIndex),
        token.type,
        Lexer,
        options,
        context
    );
    return splitTokens;
}

function appendBlockFragment(target, source, parentType, Lexer, options, context) {
    if (!source) return;
    if (parentType === 'text') {
        const tokens = lexInlineFragment(source, Lexer, options, context);
        target.push({
            type: 'text',
            raw: source,
            text: source,
            tokens: transformInlineTokens(tokens, Lexer, options, context),
        });
        return;
    }
    const tokens = lexBlockFragment(source, Lexer, options, context);
    const transformed = transformBlockTokens(tokens, Lexer, options, {
        ...context,
        links: tokens.links,
    });
    appendTokens(target, transformed);
}

function transformInlineTokens(tokens, Lexer, options, context = {}) {
    if (!tokens?.length) return [];
    const { inLink = false } = context;
    const spans = createTokenSpans(tokens);
    const source = spans.map(span => span.token.raw).join('');
    const matches = filterReplaceableMathRanges(
        findInlineMathMatches(source),
        spans
    );
    if (matches.length) {
        return replaceInlineMathRanges(source, matches, Lexer, options, context);
    }

    for (const token of tokens) {
        if (INLINE_CHILD_TOKEN_TYPES.has(token.type)
            && Array.isArray(token.tokens)) {
            token.tokens = transformInlineTokens(token.tokens, Lexer, options, {
                ...context,
                inLink: inLink || token.type === 'link',
            });
        }
    }
    return tokens;
}

function createTokenSpans(tokens) {
    let offset = 0;
    return tokens.map(token => {
        const start = offset;
        offset += token.raw.length;
        return { token, start, end: offset };
    });
}

function filterReplaceableMathRanges(matches, spans) {
    const replaceable = [];
    let spanIndex = 0;
    for (const match of matches) {
        while (spanIndex < spans.length && spans[spanIndex].end <= match.start) {
            spanIndex++;
        }
        let touchedCount = 0;
        let onlyTokenType = '';
        let allowed = true;
        for (let index = spanIndex;
            index < spans.length && spans[index].start < match.end;
            index++) {
            const type = spans[index].token.type;
            touchedCount++;
            onlyTokenType = type;
            allowed &&= MATH_RANGE_TOKEN_TYPES.has(type);
        }
        const nestedInContainer = touchedCount === 1
            && onlyTokenType !== 'text'
            && onlyTokenType !== 'escape';
        if (allowed && touchedCount && !nestedInContainer) {
            replaceable.push(match);
        }
    }
    return replaceable;
}

function replaceInlineMathRanges(source, matches, Lexer, options, context) {
    const transformed = [];
    let sourceIndex = 0;
    for (const match of matches) {
        if (match.start > sourceIndex) {
            const tokens = lexInlineFragment(
                source.slice(sourceIndex, match.start),
                Lexer,
                options,
                context
            );
            appendTokens(
                transformed,
                transformInlineTokens(tokens, Lexer, options, context)
            );
        }
        transformed.push({
            type: 'mkteroMathInline',
            raw: match.raw,
            text: match.text,
        });
        sourceIndex = match.end;
    }
    if (sourceIndex < source.length) {
        const tokens = lexInlineFragment(
            source.slice(sourceIndex),
            Lexer,
            options,
            context
        );
        appendTokens(
            transformed,
            transformInlineTokens(tokens, Lexer, options, context)
        );
    }
    return transformed;
}

function appendTokens(target, tokens) {
    for (const token of tokens) target.push(token);
}

function lexInlineFragment(source, Lexer, options, { inLink = false, links } = {}) {
    const lexer = new Lexer(options);
    if (links) lexer.tokens.links = links;
    lexer.state.inLink = inLink;
    return lexer.inlineTokens(source);
}

function lexBlockFragment(source, Lexer, options, { links } = {}) {
    const lexer = new Lexer(options);
    if (links) lexer.tokens.links = links;
    return lexer.lex(source);
}

export function findDisplayMathMatches(source) {
    const dollarMatches = [];
    const bracketMatches = [];
    let dollarOpener = null;
    let bracketOpener = null;
    const lines = splitSourceLines(source);

    for (const line of lines) {
        const inlineDollar = /^\$\$[ \t]*(.*?)[ \t]*\$\$[ \t]*$/.exec(line.text);
        if (inlineDollar?.[1].trim()) {
            dollarMatches.push(createLineMathRange(
                source,
                line,
                inlineDollar[1]
            ));
        }
        else if (/^\$\$[ \t]*$/.test(line.text)) {
            if (dollarOpener) {
                dollarMatches.push(createMultilineMathRange(
                    source,
                    dollarOpener,
                    line
                ));
                dollarOpener = null;
            }
            else {
                dollarOpener = line;
            }
        }

        const inlineBracket = /^\\\[[ \t]*(.*?)[ \t]*\\\][ \t]*$/.exec(line.text);
        if (inlineBracket?.[1].trim()) {
            bracketMatches.push(createLineMathRange(
                source,
                line,
                inlineBracket[1]
            ));
        }
        else if (/^\\\[[ \t]*$/.test(line.text)) {
            bracketOpener = line;
        }
        else if (bracketOpener && /^[ \t]*\\\][ \t]*$/.test(line.text)) {
            bracketMatches.push(createMultilineMathRange(
                source,
                bracketOpener,
                line
            ));
            bracketOpener = null;
        }
    }

    return selectNonOverlappingRanges(dollarMatches, bracketMatches);
}

function splitSourceLines(source) {
    const lines = [];
    let start = 0;
    while (start < source.length) {
        const newline = source.indexOf('\n', start);
        const end = newline < 0 ? source.length : newline;
        const next = newline < 0 ? end : end + 1;
        lines.push({
            start,
            end,
            next,
            text: source.slice(start, end),
        });
        start = next;
    }
    return lines;
}

function createLineMathRange(source, line, text) {
    return {
        start: line.start,
        end: line.next,
        raw: source.slice(line.start, line.next),
        text,
    };
}

function createMultilineMathRange(source, opener, closer) {
    const contentEnd = closer.start > opener.next
        && source[closer.start - 1] === '\n'
        ? closer.start - 1
        : closer.start;
    return {
        start: opener.start,
        end: closer.next,
        raw: source.slice(opener.start, closer.next),
        text: source.slice(opener.next, contentEnd),
    };
}

export function findInlineMathMatches(source) {
    const dollarMatches = [];
    const parenthesisMatches = [];
    let dollarOpener = -1;
    let parenthesisOpener = -1;

    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\n') {
            dollarOpener = -1;
            parenthesisOpener = -1;
            continue;
        }
        if (source.startsWith('\\(', index) && !isEscaped(source, index)) {
            parenthesisOpener = index;
            index++;
            continue;
        }
        if (source.startsWith('\\)', index) && !isEscaped(source, index)) {
            if (parenthesisOpener >= 0) {
                const match = createInlineMathMatch(
                    source,
                    parenthesisOpener,
                    index,
                    '\\(',
                    '\\)'
                );
                if (match) {
                    parenthesisMatches.push(toMathRange(match, parenthesisOpener));
                }
                parenthesisOpener = -1;
            }
            index++;
            continue;
        }
        if (!isSingleDollarAt(source, index)) continue;
        if (dollarOpener < 0) {
            dollarOpener = index;
            continue;
        }
        const match = createInlineMathMatch(
            source,
            dollarOpener,
            index,
            '$',
            '$',
            {
                rejectClosingBeforeDigit: true,
                rejectSpacedContentBeforeAlphanumeric: true,
            }
        );
        if (match) {
            dollarMatches.push(toMathRange(match, dollarOpener));
            dollarOpener = -1;
        }
        else {
            dollarOpener = index;
        }
    }

    return selectNonOverlappingRanges(dollarMatches, parenthesisMatches);
}

function toMathRange(match, start) {
    return {
        ...match,
        start,
        end: start + match.raw.length,
    };
}

function selectNonOverlappingRanges(left, right) {
    const selected = [];
    let leftIndex = 0;
    let rightIndex = 0;
    let selectedEnd = 0;
    while (leftIndex < left.length || rightIndex < right.length) {
        const useLeft = rightIndex >= right.length
            || (leftIndex < left.length
                && left[leftIndex].start <= right[rightIndex].start);
        const candidate = useLeft ? left[leftIndex++] : right[rightIndex++];
        if (candidate.start < selectedEnd) continue;
        selected.push(candidate);
        selectedEnd = candidate.end;
    }
    return selected;
}

function createInlineMathMatch(source, openerIndex, closerIndex, opener, closer, options = {}) {
    if (options.rejectClosingBeforeDigit
        && /\d/.test(source[closerIndex + closer.length] || '')) return null;
    const contentStart = openerIndex + opener.length;
    const openerIsPadded = /\s/.test(source[contentStart] || '');
    const closerIsPadded = /\s/.test(source[closerIndex - 1] || '');
    if (closerIsPadded !== openerIsPadded) return null;
    const text = source.slice(contentStart, closerIndex).trim();
    if (!text) return null;
    if (options.rejectSpacedContentBeforeAlphanumeric
        && /\s/.test(text)
        && /[\p{L}\p{N}]/u.test(source[closerIndex + closer.length] || '')) {
        return null;
    }
    return {
        raw: source.slice(openerIndex, closerIndex + closer.length),
        text,
    };
}

function inlineTokensToText(tokens) {
    return tokens.map(token => {
        if (token.type === 'mkteroMathInline') return token.text || '';
        if (Array.isArray(token.tokens)) return inlineTokensToText(token.tokens);
        if (token.type === 'br') return '\n';
        return token.text || '';
    }).join('');
}

function isSingleDollarAt(source, index) {
    return source[index] === '$'
        && source[index - 1] !== '$'
        && source[index + 1] !== '$'
        && !isEscaped(source, index);
}

function isEscaped(source, index) {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) {
        backslashes++;
    }
    return backslashes % 2 === 1;
}

function createMathRenderBudget() {
    let expressionCount = 0;
    let totalOutputLength = 0;
    let totalSourceLength = 0;
    return {
        claimSource(source) {
            if (source.length > MAX_MATH_SOURCE_LENGTH) return false;
            if (expressionCount >= MAX_MATH_EXPRESSIONS) return false;
            if (totalSourceLength + source.length > MAX_TOTAL_MATH_SOURCE_LENGTH) {
                return false;
            }
            expressionCount++;
            totalSourceLength += source.length;
            return true;
        },
        claimOutput(output) {
            if (output.length > MAX_MATH_OUTPUT_LENGTH) return false;
            if (totalOutputLength + output.length > MAX_TOTAL_MATH_OUTPUT_LENGTH) {
                return false;
            }
            totalOutputLength += output.length;
            return true;
        },
    };
}

function renderMathML(source, displayMode, mathBudget) {
    const normalizedSource = String(source).trim();
    if (UNSAFE_MATH_COMMAND.test(normalizedSource)) {
        return renderMathFallback(normalizedSource);
    }
    if (!mathBudget.claimSource(normalizedSource)) {
        return renderMathFallback(normalizedSource);
    }
    try {
        const rendered = katex.renderToString(normalizedSource, {
            displayMode,
            output: 'mathml',
            throwOnError: false,
            strict: 'ignore',
            trust: false,
            maxExpand: 100,
            maxSize: 100,
        });
        return mathBudget.claimOutput(rendered)
            ? rendered
            : renderMathFallback(normalizedSource);
    }
    catch {
        return renderMathFallback(normalizedSource);
    }
}

function renderMathFallback(source) {
    return `<code class="math-fallback">${escapeHTML(source)}</code>`;
}

export function safeMarkdownLinkURL(value) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url) || /^zotero:\/\//i.test(url) || url.startsWith('#')) {
        return url.replace(/[\u0000-\u001F\u007F]/g, '');
    }
    return null;
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
    return escapeHTML(value).replace(/[\u0000-\u001F\u007F]/g, '');
}

function escapeKnownInlineTags(value) {
    return value
        .replace(/&lt;(br|sup|sub)&gt;/gi, '<$1>')
        .replace(/&lt;\/(br|sup|sub)&gt;/gi, '</$1>');
}

function sanitizeRawHTMLTable(value) {
    const source = String(value).trim();
    if (!/^<table(?:\s|>)/i.test(source) || !/<\/table>$/i.test(source)) {
        return null;
    }

    let output = '';
    let sourceIndex = 0;
    const tagPattern = /<\/?[a-z][^<>]*>/gi;
    for (const match of source.matchAll(tagPattern)) {
        output += escapeHTMLText(source.slice(sourceIndex, match.index));
        const closing = /^<\s*\//.test(match[0]);
        const tagName = /^<\s*\/?\s*([a-z][a-z0-9]*)/i.exec(match[0])?.[1]
            ?.toLowerCase();
        output += SAFE_TABLE_TAGS.has(tagName)
            ? sanitizeTableTag(match[0], tagName, closing)
            : escapeHTML(match[0]);
        sourceIndex = match.index + match[0].length;
    }
    output += escapeHTMLText(source.slice(sourceIndex));
    return output;
}

function sanitizeTableTag(rawTag, tagName, closing) {
    if (closing) return `</${tagName}>`;
    let attributes = '';
    const attributeNames = tagName === 'td' || tagName === 'th'
        ? ['rowspan', 'colspan']
        : tagName === 'col' || tagName === 'colgroup'
            ? ['span']
            : [];
    for (const name of attributeNames) {
        const value = readNumericHTMLAttribute(rawTag, name);
        if (value !== null) attributes += ` ${name}="${value}"`;
    }
    return `<${tagName}${attributes}>`;
}

function readNumericHTMLAttribute(rawTag, name) {
    const source = rawTag
        .replace(/^<\s*[a-z][a-z0-9]*/i, '')
        .replace(/\/?>\s*$/, '');
    const attributePattern = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    for (const match of source.matchAll(attributePattern)) {
        if (match[1].toLowerCase() !== name) continue;
        const rawValue = match[2] ?? match[3] ?? match[4];
        if (!/^\d+$/.test(rawValue)) return null;
        const value = Number(rawValue);
        return Number.isSafeInteger(value) && value >= 1 && value <= 1000
            ? String(value)
            : null;
    }
    return null;
}

function escapeHTMLText(value) {
    return escapeHTML(value).replace(
        /&amp;((?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);)/gi,
        '&$1'
    );
}
