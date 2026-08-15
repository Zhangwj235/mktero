import {
    createNormalizedTextIndex,
    isLikelyNumericSuperscriptExponent,
    isNumericCitationContent,
} from './text-normalization.js';

const SINGLE_QUOTES = new Set(['‘', '’', '‛']);
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟']);
const HYPHENS = new Set(['‐', '‑', '‒', '–', '—', '−']);
const CITATION_WRAPPER = /\$\[([0-9,，;；\s–—-]{1,512})\]\$/gu;
const NUMERIC_SUPERSCRIPT = /\$\^\{\s*([0-9][0-9,，;；\s–—-]{0,511}?)\s*\}\$/gu;
const TRADEMARK_SUPERSCRIPT = /\$\^\{([®©™])\}\$/gu;
const SENTENCE_FOOTNOTE_SUPERSCRIPT = /\$\^\{([0-9]{1,4})\}\$/gu;
const STATISTICAL_NUMERIC_EXPONENT = /\^\{\s*([0-9]{1,4})\s*\}(?=\s*(?:<=|>=|!=|[=<>≤≥≠]))/gu;
const SENTENCE_END = /[.!?。！？]/u;
const RELATIONAL_OPERATOR_PATTERN = /([\p{L}\p{N})\]}([{])(\s*)(<=|>=|!=|[=<>≤≥≠])(\s*)(?=[\p{L}\p{N}([{\-+−±.])/gu;
const LATEX_RELATIONAL_OPERATOR_PATTERN = /([\p{L}\p{N})\]}([{])(\s*)(\\(?:geq|ge|leq|le|neq|ne))(?![A-Za-z])(\s*)(?=[\p{L}\p{N}([{\-+−±.])/gu;
const OPENING_DELIMITER_SIGNED_NUMBER_WHITESPACE_PATTERN = /[([{](\s+)(?=(?:[+\-−±]|(?<!\\)\\pm)\s*\d)/gu;
const SIGNED_NUMBER_WHITESPACE_PATTERN = /(?:[+\-−±]|(?<!\\)\\pm)(\s+)(?=\d)/gu;
const DEGREE_SYMBOL_WHITESPACE_PATTERN = /([\p{N})\]}])(\s+)(?=°)/gu;
const DEGREE_SYMBOL_UNIT_WHITESPACE_PATTERN = /°(\s+)(?=\p{L})/gu;
const LATEX_TEXT_UNIT_PATTERN = /(?<!\\)\\mathrm\{([A-Za-z]{1,32})\}/gu;
const PDF_ANNOTATION_SYMBOL_REPLACEMENTS = [
    { pattern: /(?<![\\;])(?:\\;)?\^\{\\circ\}/gu, text: '°' },
    { pattern: /(?<!\\)\\pm(?![A-Za-z])/gu, text: '±' },
    { pattern: /(?<!\\)\\(?:geq|ge)(?![A-Za-z])/gu, text: '≥' },
    { pattern: /(?<!\\)\\(?:leq|le)(?![A-Za-z])/gu, text: '≤' },
    { pattern: /(?<!\\)\\(?:neq|ne)(?![A-Za-z])/gu, text: '≠' },
    { pattern: />=/gu, text: '≥' },
    { pattern: /<=/gu, text: '≤' },
    { pattern: /!=/gu, text: '≠' },
];

export function normalizePdfAnnotationText(text) {
    return createPdfAnnotationTextIndex(String(text)).text.trim();
}

export function expandPdfAnnotationSourceRange(source, range) {
    const symbol = source.slice(range.from, range.to);
    const wrapperFrom = range.from - 3;
    const wrapperTo = range.to + 2;
    if (wrapperFrom >= 0
        && /^[®©™]$/u.test(symbol)
        && source.slice(wrapperFrom, wrapperTo) === `$^{${symbol}}$`) {
        return { from: wrapperFrom, to: wrapperTo };
    }
    if (wrapperFrom >= 0
        && /^[0-9]{1,4}$/u.test(symbol)
        && source.slice(wrapperFrom, wrapperTo) === `$^{${symbol}}$`
        && sentenceFootnoteWhitespaceFrom(source, wrapperFrom) !== null) {
        return { from: wrapperFrom, to: wrapperTo };
    }
    return range;
}

export function createPdfAnnotationTextIndex(
    text,
    sourceOffsetAt = offset => offset
) {
    const markup = collectNormalizationMarkup(text);
    return createNormalizedTextIndex(
        text,
        sourceOffsetAt,
        (character, offset, source) => normalizePdfAnnotationCharacter(
            character,
            offset,
            source,
            markup
        )
    );
}

export function createDehyphenatedPdfAnnotationTextIndex(text) {
    return createLineWrappedPdfAnnotationTextIndex(text, false);
}

export function createHyphenPreservingPdfAnnotationTextIndex(text) {
    return createLineWrappedPdfAnnotationTextIndex(text, true);
}

function createLineWrappedPdfAnnotationTextIndex(text, preserveHyphen) {
    const normalized = createPdfAnnotationTextIndex(String(text));
    const output = [];
    const sourceStarts = [];
    const sourceEnds = [];
    for (let offset = 0; offset < normalized.text.length;) {
        const character = String.fromCodePoint(
            normalized.text.codePointAt(offset)
        );
        const nextOffset = offset + character.length;
        const hasWhitespace = character === '-'
            && normalized.text[nextOffset] === ' ';
        const afterWhitespace = nextOffset + (hasWhitespace ? 1 : 0);
        if (character === '-'
            && isLetterBefore(normalized.text, offset)
            && isLetterAt(normalized.text, afterWhitespace)
            && hasWhitespace) {
            if (preserveHyphen) {
                output.push(character);
                sourceStarts.push(offset);
                sourceEnds.push(nextOffset);
            }
            offset = afterWhitespace;
            continue;
        }
        for (let unit = 0; unit < character.length; unit++) {
            output.push(character[unit]);
            sourceStarts.push(offset);
            sourceEnds.push(nextOffset);
        }
        offset = nextOffset;
    }
    return {
        text: output.join(''),
        sourceRange(from, length) {
            const normalizedFrom = sourceStarts[from];
            const normalizedTo = sourceEnds[from + length - 1];
            return normalized.sourceRange(
                normalizedFrom,
                normalizedTo - normalizedFrom
            );
        },
    };
}

function isLetterBefore(text, offset) {
    if (offset <= 0) return false;
    let previousOffset = offset - 1;
    if (previousOffset > 0
        && isLowSurrogate(text.charCodeAt(previousOffset))
        && isHighSurrogate(text.charCodeAt(previousOffset - 1))) {
        previousOffset--;
    }
    const character = String.fromCodePoint(text.codePointAt(previousOffset));
    return /^\p{L}$/u.test(character);
}

function isLetterAt(text, offset) {
    if (offset >= text.length) return false;
    const character = String.fromCodePoint(text.codePointAt(offset));
    return /^\p{L}$/u.test(character);
}

function isHighSurrogate(value) {
    return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value) {
    return value >= 0xDC00 && value <= 0xDFFF;
}

function normalizePdfAnnotationCharacter(
    character,
    offset,
    source,
    markup
) {
    const replacement = markup.replacements.get(offset);
    if (replacement) {
        return {
            text: replacement.text ?? character,
            sourceFrom: replacement.from,
            sourceTo: replacement.to,
        };
    }
    if (markup.ignoredOffsets.has(offset)) return '';
    if (/^\s$/u.test(character)
        && /^\s*[,.;:!?，。；：！？®©™]/u.test(
            source.slice(offset + character.length)
        )) {
        return '';
    }
    if (SINGLE_QUOTES.has(character)) return "'";
    if (DOUBLE_QUOTES.has(character)) return '"';
    if (HYPHENS.has(character)) return '-';
    if (character === '\uFFFD'
        && /^\p{N}$/u.test(source[offset - 1] || '')
        && /^[CF](?![\p{L}\p{N}])/u.test(source.slice(offset + 1))) {
        return '°';
    }
    return character.normalize('NFKC');
}

function collectNormalizationMarkup(text) {
    const ignoredOffsets = new Set();
    const replacements = new Map();
    markAnnotationSymbols(text, ignoredOffsets, replacements);
    markStatisticalNumericExponents(text, ignoredOffsets, replacements);
    markMathematicalWhitespace(text, ignoredOffsets);
    for (const match of text.matchAll(CITATION_WRAPPER)) {
        if (!isNumericCitationContent(match[1])) continue;
        ignoredOffsets.add(match.index);
        ignoredOffsets.add(match.index + match[0].length - 1);
    }
    for (const match of text.matchAll(NUMERIC_SUPERSCRIPT)) {
        const value = match[1].trim();
        if (!isNumericCitationContent(value)
            || !hasInlineSuperscriptContext(text, match.index)
            || isLikelyNumericSuperscriptExponent(
                text,
                match.index,
                value
            )) {
            continue;
        }
        const contentFrom = match.index + match[0].indexOf(value);
        const contentTo = contentFrom + value.length;
        for (
            let offset = match.index;
            offset < match.index + match[0].length;
            offset++
        ) {
            if (offset < contentFrom || offset >= contentTo) {
                ignoredOffsets.add(offset);
                continue;
            }
            const character = text[offset];
            replacements.set(offset, {
                from: match.index,
                to: match.index + match[0].length,
                text: HYPHENS.has(character)
                    ? '-'
                    : character.normalize('NFKC'),
            });
        }
    }
    for (const match of text.matchAll(TRADEMARK_SUPERSCRIPT)) {
        const symbolOffset = match.index + match[0].indexOf(match[1]);
        replacements.set(symbolOffset, {
            from: match.index,
            to: match.index + match[0].length,
        });
        for (
            let offset = match.index;
            offset < match.index + match[0].length;
            offset++
        ) {
            if (offset !== symbolOffset) ignoredOffsets.add(offset);
        }
        for (
            let offset = match.index - 1;
            offset >= 0 && /\s/u.test(text[offset]);
            offset--
        ) {
            ignoredOffsets.add(offset);
        }
    }
    for (const match of text.matchAll(SENTENCE_FOOTNOTE_SUPERSCRIPT)) {
        const whitespaceFrom = sentenceFootnoteWhitespaceFrom(
            text,
            match.index
        );
        if (whitespaceFrom === null) continue;
        const contentFrom = match.index + match[0].indexOf(match[1]);
        const contentTo = contentFrom + match[1].length;
        for (
            let offset = match.index;
            offset < match.index + match[0].length;
            offset++
        ) {
            if (offset < contentFrom || offset >= contentTo) {
                ignoredOffsets.add(offset);
            }
        }
        for (let offset = contentFrom; offset < contentTo; offset++) {
            replacements.set(offset, {
                from: match.index,
                to: match.index + match[0].length,
            });
        }
        for (let offset = whitespaceFrom; offset < match.index; offset++) {
            ignoredOffsets.add(offset);
        }
    }
    return { ignoredOffsets, replacements };
}

function markStatisticalNumericExponents(
    text,
    ignoredOffsets,
    replacements
) {
    for (const match of text.matchAll(STATISTICAL_NUMERIC_EXPONENT)) {
        if (!isLikelyNumericSuperscriptExponent(
            text,
            match.index,
            match[1]
        )) {
            continue;
        }
        const contentFrom = match.index + match[0].indexOf(match[1]);
        const contentTo = contentFrom + match[1].length;
        for (
            let offset = match.index;
            offset < match.index + match[0].length;
            offset++
        ) {
            if (offset < contentFrom || offset >= contentTo) {
                ignoredOffsets.add(offset);
            }
            else {
                replacements.set(offset, {
                    from: match.index,
                    to: match.index + match[0].length,
                });
            }
        }
    }
}

function markAnnotationSymbols(text, ignoredOffsets, replacements) {
    for (const replacement of PDF_ANNOTATION_SYMBOL_REPLACEMENTS) {
        for (const match of text.matchAll(replacement.pattern)) {
            replacements.set(match.index, {
                from: match.index,
                to: match.index + match[0].length,
                text: replacement.text,
            });
            markOffsetRange(
                ignoredOffsets,
                match.index + 1,
                match[0].length - 1
            );
        }
    }
    for (const match of text.matchAll(LATEX_TEXT_UNIT_PATTERN)) {
        replacements.set(match.index, {
            from: match.index,
            to: match.index + match[0].length,
            text: match[1],
        });
        markOffsetRange(
            ignoredOffsets,
            match.index + 1,
            match[0].length - 1
        );
    }
}

function markMathematicalWhitespace(text, ignoredOffsets) {
    for (const pattern of [
        RELATIONAL_OPERATOR_PATTERN,
        LATEX_RELATIONAL_OPERATOR_PATTERN,
    ]) {
        markRelationalOperatorWhitespace(text, pattern, ignoredOffsets);
    }
    for (const match of text.matchAll(
        OPENING_DELIMITER_SIGNED_NUMBER_WHITESPACE_PATTERN
    )) {
        markOffsetRange(
            ignoredOffsets,
            match.index + 1,
            match[1].length
        );
    }
    for (const match of text.matchAll(SIGNED_NUMBER_WHITESPACE_PATTERN)) {
        markOffsetRange(
            ignoredOffsets,
            match.index + match[0].length - match[1].length,
            match[1].length
        );
    }
    for (const match of text.matchAll(DEGREE_SYMBOL_WHITESPACE_PATTERN)) {
        markOffsetRange(
            ignoredOffsets,
            match.index + match[1].length,
            match[2].length
        );
    }
    for (const match of text.matchAll(
        DEGREE_SYMBOL_UNIT_WHITESPACE_PATTERN
    )) {
        markOffsetRange(
            ignoredOffsets,
            match.index + 1,
            match[1].length
        );
    }
}

function markRelationalOperatorWhitespace(text, pattern, ignoredOffsets) {
    for (const match of text.matchAll(pattern)) {
        const leftLength = match[1].length;
        markOffsetRange(
            ignoredOffsets,
            match.index + leftLength,
            match[2].length
        );
        markOffsetRange(
            ignoredOffsets,
            match.index + leftLength + match[2].length + match[3].length,
            match[4].length
        );
    }
}

function markOffsetRange(offsets, from, length) {
    for (let offset = from; offset < from + length; offset++) {
        offsets.add(offset);
    }
}

function sentenceFootnoteWhitespaceFrom(text, wrapperFrom) {
    let whitespaceFrom = wrapperFrom;
    while (whitespaceFrom > 0 && /[ \t]/u.test(text[whitespaceFrom - 1])) {
        whitespaceFrom--;
    }
    return whitespaceFrom > 0 && SENTENCE_END.test(text[whitespaceFrom - 1])
        ? whitespaceFrom
        : null;
}

function hasInlineSuperscriptContext(text, wrapperFrom) {
    let offset = wrapperFrom - 1;
    while (offset >= 0 && /[ \t]/u.test(text[offset])) offset--;
    return offset >= 0
        && !/[\r\n]/u.test(text[offset])
        && /[\p{L}\p{N})\]}.!?,;:。！？，；：'’”]/u.test(text[offset]);
}
