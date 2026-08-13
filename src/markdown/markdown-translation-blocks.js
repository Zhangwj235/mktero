import { GFM, parser as markdownParser } from '@lezer/markdown';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
} from './markdown-html.js';

const MARKDOWN_PARSER = markdownParser.configure(GFM);
const HEADING_PATTERN = /^(?:ATXHeading[1-6]|SetextHeading[12])$/;
const TRANSLATABLE_NODE_TYPES = new Map([
    ['Paragraph', 'paragraph'],
    ['BulletList', 'list'],
    ['OrderedList', 'list'],
    ['Blockquote', 'blockquote'],
    ['Table', 'table'],
]);
const PROTECTED_NODE_TYPES = new Set([
    'Image',
    'InlineCode',
    'HTMLBlock',
    'HTMLTag',
    'URL',
    'FencedCode',
    'CodeBlock',
]);
const PROTECTED_PLACEHOLDER_PATTERN = /MKTEROPROTECTED\d+PLACEHOLDER/g;
const DOCUMENT_MARKER_PATTERN = /MKTEROBLOCK\d+(?:START|END)MARKER/g;
const REFERENCE_HEADING_PATTERN = /^(?:references?|bibliography|works cited|literature cited|参考文献|参考资料|参考书目|引用文献)$/iu;
const NUMERIC_CITATION_PATTERN = /\[(?:\d{1,4}[a-z]?(?:[ \t]*[-–—,，;；][ \t]*\d{1,4}[a-z]?)*)(?:[ \t]*,[ \t]*)?\]/giu;
export const MAX_TRANSLATION_BATCH_BLOCKS = 8;
export const MAX_TRANSLATION_BATCH_SOURCE_TOKENS = 2_000;

export function collectMarkdownTranslationBlocks(markdown) {
    const source = String(markdown || '');
    const blocks = [];
    const createPlaceholder = createProtectedPlaceholderFactory(source);
    const createDocumentMarkers = createDocumentMarkerFactory(source);
    let ordinal = 0;
    let referenceSection = false;
    for (let node = MARKDOWN_PARSER.parse(source).topNode.firstChild;
        node;
        node = node.nextSibling) {
        const blockMarkdown = source.slice(node.from, node.to);
        const referenceHeading = isReferenceHeading(node.name, blockMarkdown);
        if (isTopLevelH1Node(node.name) && !referenceHeading) {
            referenceSection = false;
        }
        if (referenceHeading) {
            referenceSection = true;
        }
        const type = translationBlockType(node.name);
        const protectedRanges = collectProtectedRanges(node, blockMarkdown);
        const protectedBlock = protectMarkdown(
            blockMarkdown,
            protectedRanges,
            createPlaceholder
        );
        const translatable = !referenceSection
            && isTranslatableBlock(
                node,
                blockMarkdown,
                protectedBlock.markdown,
                protectedBlock.fragments
            );
        const requestBlock = translatable
            ? protectedBlock
            : protectMarkdown(blockMarkdown, [{
                from: 0,
                to: blockMarkdown.length,
            }], createPlaceholder);
        const documentMarkers = createDocumentMarkers();
        blocks.push({
            id: `translation-${ordinal}-${node.from}-${node.to}-${type}`,
            type,
            nodeType: node.name,
            from: node.from,
            to: node.to,
            markdown: blockMarkdown,
            requestMarkdown: requestBlock.markdown,
            protectedFragments: requestBlock.fragments,
            ...documentMarkers,
            translatable,
        });
        ordinal++;
    }
    return blocks;
}

export function collectMarkdownTranslationSections(markdown, blocks) {
    const source = String(markdown || '');
    if (!Array.isArray(blocks)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    const sections = [];
    let sectionBlocks = [];
    const appendSection = () => {
        if (!sectionBlocks.length) return;
        sections.push(sectionBlocks);
        sectionBlocks = [];
    };
    for (const block of blocks) {
        if (isTopLevelH1(block) && sectionBlocks.length) appendSection();
        sectionBlocks.push(block);
    }
    appendSection();
    return sections.map((sectionBlocks, index) => ({
        index,
        blocks: sectionBlocks,
        translatableBlocks: sectionBlocks.filter(block => block.translatable),
        requestMarkdown: createMarkdownTranslationRequest('', sectionBlocks),
        source: source.slice(
            sectionBlocks[0].from,
            sectionBlocks.at(-1).to
        ),
    }));
}

export function createMarkdownTranslationBatches(section, {
    maxBlocks = MAX_TRANSLATION_BATCH_BLOCKS,
    maxSourceTokens = MAX_TRANSLATION_BATCH_SOURCE_TOKENS,
} = {}) {
    if (!Array.isArray(section?.blocks)) {
        throw new TypeError('A Markdown translation section is required');
    }
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) {
        throw new RangeError('The Markdown translation batch block limit is invalid');
    }
    if (!Number.isSafeInteger(maxSourceTokens) || maxSourceTokens < 1) {
        throw new RangeError('The Markdown translation batch token limit is invalid');
    }
    const batches = [];
    let batchBlocks = [];
    let translatableCount = 0;
    let sourceTokens = 0;
    const appendBatch = () => {
        if (!batchBlocks.length || !translatableCount) {
            batchBlocks = [];
            translatableCount = 0;
            sourceTokens = 0;
            return;
        }
        batches.push({
            blocks: batchBlocks,
            translatableBlocks: batchBlocks.filter(block => block.translatable),
            requestPayload: createMarkdownTranslationBatchPayload(batchBlocks),
        });
        batchBlocks = [];
        translatableCount = 0;
        sourceTokens = 0;
    };
    for (const block of section.blocks) {
        const blockTokens = estimateMarkdownTokens(block.requestMarkdown);
        const exceedsBlockLimit = block.translatable
            && translatableCount >= maxBlocks;
        const exceedsTokenLimit = batchBlocks.length
            && sourceTokens + blockTokens > maxSourceTokens;
        if (batchBlocks.length && (exceedsBlockLimit || exceedsTokenLimit)) {
            appendBatch();
        }
        batchBlocks.push(block);
        sourceTokens += blockTokens;
        if (block.translatable) translatableCount++;
    }
    appendBatch();
    return batches;
}

export function createMarkdownTranslationBatchPayload(blocks) {
    if (!Array.isArray(blocks)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    return JSON.stringify(blocks.flatMap(block => block.translatable ? [{
        id: block.id,
        sourceMarkdown: block.requestMarkdown,
    }] : []));
}

export function collectMarkdownTranslationBatchResponse(blocks, response) {
    if (!Array.isArray(blocks)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    const expectedBlocks = blocks.filter(block => block.translatable);
    const expectedIDs = new Set(expectedBlocks.map(block => block.id));
    const parsed = parseTranslationResponse(response);
    if (!Array.isArray(parsed)) {
        throw new Error('The translated Markdown batch must be a JSON array');
    }
    const responsesByID = new Map();
    for (const entry of parsed) {
        const id = String(entry?.id || '');
        if (!id) continue;
        if (!expectedIDs.has(id)) {
            throw new Error('The AI returned an unknown Markdown block ID');
        }
        const entries = responsesByID.get(id) || [];
        entries.push(entry);
        responsesByID.set(id, entries);
    }
    const translations = [];
    const failures = [];
    for (const block of expectedBlocks) {
        const entries = responsesByID.get(block.id) || [];
        if (entries.length !== 1
            || typeof entries[0].translatedMarkdown !== 'string') {
            failures.push({
                id: block.id,
                message: entries.length > 1
                    ? 'The AI returned a duplicate Markdown block translation'
                    : 'The AI omitted a Markdown block translation',
            });
            continue;
        }
        try {
            validateTranslatedBlock(block, entries[0].translatedMarkdown);
            translations.push({
                id: block.id,
                markdown: entries[0].translatedMarkdown,
            });
        }
        catch (error) {
            failures.push({
                id: block.id,
                message: error?.message || 'The translated Markdown block is invalid',
            });
        }
    }
    return { translations, failures };
}

export function createMarkdownTranslationRequest(markdown, blocks) {
    if (!blocks.length) return String(markdown || '');
    return blocks.map(block => [
        block.documentStartMarker,
        block.requestMarkdown,
        block.documentEndMarker,
    ].join('\n\n')).join('\n\n');
}

export function collectDocumentTranslations(
    requestMarkdown,
    blocks,
    translatedMarkdown
) {
    if (!Array.isArray(blocks)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    const request = String(requestMarkdown || '');
    if (request !== createMarkdownTranslationRequest('', blocks)) {
        throw new Error('The Markdown translation request is invalid');
    }
    const translated = String(translatedMarkdown || '').trim();
    if (!translated) throw new Error('The translated Markdown document is empty');
    const translatedBlocks = extractMarkedDocumentBlocks(blocks, translated);
    const translations = [];
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const translatedBlock = translatedBlocks[index];
        if (!block.translatable) {
            if (translatedBlock !== block.requestMarkdown) {
                throw new Error(
                    'The translated Markdown document changed protected content'
                );
            }
            continue;
        }
        validateTranslatedBlock(block, translatedBlock);
        translations.push({
            id: block.id,
            markdown: translatedBlock,
        });
    }
    return translations;
}

function extractMarkedDocumentBlocks(blocks, translated) {
    const expectedMarkers = blocks.flatMap(block => [
        block.documentStartMarker,
        block.documentEndMarker,
    ]);
    const actualMarkers = translated.match(DOCUMENT_MARKER_PATTERN) || [];
    if (actualMarkers.length !== expectedMarkers.length
        || actualMarkers.some((marker, index) => marker !== expectedMarkers[index])) {
        throw new Error(
            'The translated Markdown document changed its block order or structure'
        );
    }
    const translatedBlocks = [];
    let cursor = 0;
    for (const block of blocks) {
        const start = translated.indexOf(block.documentStartMarker, cursor);
        if (start < 0 || translated.slice(cursor, start).trim()) {
            throw new Error('The translated Markdown document changed its structure');
        }
        const contentFrom = start + block.documentStartMarker.length;
        const end = translated.indexOf(block.documentEndMarker, contentFrom);
        if (end < 0) {
            throw new Error('The translated Markdown document changed its structure');
        }
        translatedBlocks.push(translated.slice(contentFrom, end).trim());
        cursor = end + block.documentEndMarker.length;
    }
    if (translated.slice(cursor).trim()) {
        throw new Error('The translated Markdown document changed its structure');
    }
    return translatedBlocks;
}

export function assembleTranslatedMarkdown(markdown, blocks, translations) {
    return replaceTranslatedBlocks(markdown, blocks, translations);
}

export function createComparisonMarkdown(markdown, blocks, translations) {
    const source = String(markdown || '');
    const translatedByID = validateTranslationSet(blocks, translations);
    const chunks = [];
    let cursor = 0;
    for (const block of blocks) {
        chunks.push(source.slice(cursor, block.from));
        chunks.push(block.markdown);
        if (block.translatable) {
            const translated = validateTranslatedBlock(
                block,
                translatedByID.get(block.id)
            );
            chunks.push('\n\n', quoteMarkdown(translated));
        }
        cursor = block.to;
    }
    chunks.push(source.slice(cursor));
    return chunks.join('');
}

export function validateTranslatedBlock(block, translatedMarkdown) {
    if (!block?.translatable) {
        throw new TypeError('Only translatable Markdown blocks can be validated');
    }
    const translated = String(translatedMarkdown || '').trim();
    if (!translated) throw new Error('The translated Markdown block is empty');
    validateProtectedPlaceholders(block, translated);
    const nodes = topLevelNodes(translated);
    if (nodes.length !== 1 || nodes[0].name !== block.nodeType) {
        throw new Error('The translated Markdown block changed its structure');
    }
    let unsafe = false;
    MARKDOWN_PARSER.parse(translated).iterate({
        enter(node) {
            if (node.name === 'HTMLBlock'
                || node.name === 'HTMLTag'
                || node.name === 'Image') {
                unsafe = true;
            }
        },
    });
    if (unsafe) {
        throw new Error('The translated Markdown block contains unsafe structure');
    }
    return restoreProtectedFragments(block, translated);
}

function replaceTranslatedBlocks(markdown, blocks, translations) {
    const source = String(markdown || '');
    const translatedByID = validateTranslationSet(blocks, translations);
    const chunks = [];
    let cursor = 0;
    for (const block of blocks) {
        chunks.push(source.slice(cursor, block.from));
        chunks.push(block.translatable
            ? validateTranslatedBlock(block, translatedByID.get(block.id))
            : block.markdown);
        cursor = block.to;
    }
    chunks.push(source.slice(cursor));
    return chunks.join('');
}

function validateTranslationSet(blocks, translations) {
    if (!Array.isArray(blocks) || !Array.isArray(translations)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    const translatedByID = new Map();
    for (const translation of translations) {
        const id = String(translation?.id || '');
        if (!id || translatedByID.has(id)) {
            throw new Error('The Markdown translation set is invalid');
        }
        translatedByID.set(id, String(translation.markdown || ''));
    }
    for (const block of blocks) {
        if (block.translatable && !translatedByID.has(block.id)) {
            throw new Error('A Markdown block translation is missing');
        }
    }
    return translatedByID;
}

function isTranslatableBlock(
    node,
    markdown,
    requestMarkdown,
    protectedFragments
) {
    if (!translationBlockType(node.name)
        || !TRANSLATABLE_NODE_TYPES.has(node.name)
        && !HEADING_PATTERN.test(node.name)) {
        return false;
    }
    if (isStandaloneDisplayMath(markdown)) return false;
    const withoutProtected = protectedFragments.reduce(
        (value, fragment) => value.replace(fragment.placeholder, ''),
        requestMarkdown
    );
    return hasTranslatableContent(withoutProtected);
}

function collectProtectedRanges(node, markdown) {
    const ranges = [];
    node.cursor().iterate(current => {
        if (!PROTECTED_NODE_TYPES.has(current.name)) return;
        ranges.push({
            from: current.from - node.from,
            to: current.to - node.from,
        });
        return false;
    });
    for (const match of findInlineMathMatches(markdown)) {
        ranges.push({ from: match.start, to: match.end });
    }
    for (const match of findContainerDisplayMathMatches(markdown)) {
        ranges.push({ from: match.start, to: match.end });
    }
    for (const match of markdown.matchAll(
        new RegExp(PROTECTED_PLACEHOLDER_PATTERN.source, 'g')
    )) {
        ranges.push({
            from: match.index,
            to: match.index + match[0].length,
        });
    }
    for (const match of markdown.matchAll(
        new RegExp(DOCUMENT_MARKER_PATTERN.source, 'g')
    )) {
        ranges.push({
            from: match.index,
            to: match.index + match[0].length,
        });
    }
    for (const match of markdown.matchAll(
        new RegExp(NUMERIC_CITATION_PATTERN.source, 'giu')
    )) {
        ranges.push({
            from: match.index,
            to: match.index + match[0].length,
        });
    }
    return selectOuterRanges(ranges, markdown.length);
}

function findContainerDisplayMathMatches(markdown) {
    const lines = sourceLines(markdown);
    const matches = [];
    let dollarOpener = null;
    let bracketOpener = null;
    for (const line of lines) {
        const contentStart = markdownContainerContentStart(line.text);
        const content = line.text.slice(contentStart);
        const inlineDollar = /^\$\$[ \t]*(.*?)[ \t]*\$\$[ \t]*$/.exec(content);
        if (inlineDollar?.[1].trim()) {
            matches.push({
                start: line.start + contentStart,
                end: line.end,
            });
        }
        else if (/^\$\$[ \t]*$/.test(content)) {
            if (dollarOpener) {
                matches.push({
                    start: dollarOpener.start,
                    end: line.end,
                });
                dollarOpener = null;
            }
            else {
                dollarOpener = { start: line.start + contentStart };
            }
        }

        const inlineBracket = /^\\\[[ \t]*(.*?)[ \t]*\\\][ \t]*$/.exec(
            content
        );
        if (inlineBracket?.[1].trim()) {
            matches.push({
                start: line.start + contentStart,
                end: line.end,
            });
        }
        else if (/^\\\[[ \t]*$/.test(content)) {
            bracketOpener = { start: line.start + contentStart };
        }
        else if (bracketOpener && /^\\\][ \t]*$/.test(content)) {
            matches.push({
                start: bracketOpener.start,
                end: line.end,
            });
            bracketOpener = null;
        }
    }
    return matches;
}

function sourceLines(source) {
    const lines = [];
    let start = 0;
    while (start < source.length) {
        const newline = source.indexOf('\n', start);
        const end = newline < 0 ? source.length : newline;
        lines.push({ start, end, text: source.slice(start, end) });
        start = newline < 0 ? source.length : newline + 1;
    }
    return lines;
}

function markdownContainerContentStart(line) {
    let offset = 0;
    while (offset < line.length) {
        while (offset < line.length && /[ \t]/.test(line[offset])) offset++;
        if (line[offset] !== '>') break;
        offset++;
        if (line[offset] === ' ' || line[offset] === '\t') offset++;
    }
    return offset;
}

function selectOuterRanges(ranges, sourceLength) {
    const selected = [];
    const sorted = ranges
        .filter(range => Number.isSafeInteger(range.from)
            && Number.isSafeInteger(range.to)
            && range.from >= 0
            && range.to > range.from
            && range.to <= sourceLength)
        .sort((left, right) => left.from - right.from || right.to - left.to);
    for (const range of sorted) {
        const previous = selected.at(-1);
        if (previous && range.from < previous.to) continue;
        selected.push(range);
    }
    return selected;
}

function protectMarkdown(markdown, ranges, createPlaceholder) {
    const fragments = [];
    const chunks = [];
    let cursor = 0;
    for (const range of ranges) {
        const placeholder = createPlaceholder();
        chunks.push(markdown.slice(cursor, range.from), placeholder);
        fragments.push({
            placeholder,
            markdown: markdown.slice(range.from, range.to),
        });
        cursor = range.to;
    }
    chunks.push(markdown.slice(cursor));
    return { markdown: chunks.join(''), fragments };
}

function createProtectedPlaceholderFactory(source) {
    const reserved = new Set(
        String(source || '').match(PROTECTED_PLACEHOLDER_PATTERN) || []
    );
    let placeholderIndex = 0;
    return () => {
        let placeholder;
        do {
            placeholder = `MKTEROPROTECTED${placeholderIndex}PLACEHOLDER`;
            placeholderIndex++;
        } while (reserved.has(placeholder));
        reserved.add(placeholder);
        return placeholder;
    };
}

function createDocumentMarkerFactory(source) {
    const reserved = new Set(
        String(source || '').match(DOCUMENT_MARKER_PATTERN) || []
    );
    let markerIndex = 0;
    return () => {
        let start;
        let end;
        do {
            start = `MKTEROBLOCK${markerIndex}STARTMARKER`;
            end = `MKTEROBLOCK${markerIndex}ENDMARKER`;
            markerIndex++;
        } while (reserved.has(start) || reserved.has(end));
        reserved.add(start);
        reserved.add(end);
        return {
            documentStartMarker: start,
            documentEndMarker: end,
        };
    };
}

function validateProtectedPlaceholders(block, translated) {
    const expected = new Set(
        (block.protectedFragments || []).map(fragment => fragment.placeholder)
    );
    const actual = translated.match(PROTECTED_PLACEHOLDER_PATTERN) || [];
    if (actual.length !== expected.size
        || new Set(actual).size !== actual.length
        || actual.some(placeholder => !expected.has(placeholder))) {
        throw new Error('The translated Markdown block changed protected content');
    }
    const originalTree = MARKDOWN_PARSER.parse(block.requestMarkdown);
    const translatedTree = MARKDOWN_PARSER.parse(translated);
    for (const placeholder of expected) {
        if (placeholderNodePath(originalTree, block.requestMarkdown, placeholder)
            !== placeholderNodePath(translatedTree, translated, placeholder)) {
            throw new Error(
                'The translated Markdown block changed protected structure'
            );
        }
    }
}

function placeholderNodePath(tree, source, placeholder) {
    const from = source.indexOf(placeholder);
    if (from < 0) return '';
    const to = from + placeholder.length;
    const path = [];
    for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
        if (node.from <= from && node.to >= to) path.push(node.name);
    }
    return path.reverse().join('/');
}

function restoreProtectedFragments(block, translated) {
    return (block.protectedFragments || []).reduce(
        (value, fragment) => value.replace(
            fragment.placeholder,
            () => fragment.markdown
        ),
        translated
    );
}

function hasTranslatableContent(markdown) {
    const content = String(markdown || '')
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
        .replace(/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/gm, '')
        .replace(/[\s|*_~`#>()[\]{}.!,:;\\/+-]/g, '');
    return /[\p{L}\p{N}]/u.test(content);
}

function isStandaloneDisplayMath(markdown) {
    const source = markdown.trim();
    return findDisplayMathMatches(source).some(match => (
        match.start === 0 && match.end === source.length
    ));
}

function translationBlockType(nodeName) {
    if (HEADING_PATTERN.test(nodeName)) return 'heading';
    return TRANSLATABLE_NODE_TYPES.get(nodeName) || 'structural';
}

function isTopLevelH1(block) {
    return isTopLevelH1Node(block?.nodeType);
}

function isTopLevelH1Node(nodeName) {
    return nodeName === 'ATXHeading1' || nodeName === 'SetextHeading1';
}

function isReferenceHeading(nodeName, markdown) {
    if (!HEADING_PATTERN.test(nodeName)) return false;
    const label = String(markdown || '')
        .replace(/^#{1,6}[ \t]+/, '')
        .replace(/[ \t]+#*[ \t]*$/, '')
        .replace(/\r?\n[=-]+[ \t]*$/, '')
        .replace(/[*_`]/g, '')
        .replace(/[：:][ \t]*$/, '')
        .trim();
    return REFERENCE_HEADING_PATTERN.test(label);
}

function topLevelNodes(markdown) {
    const nodes = [];
    for (let node = MARKDOWN_PARSER.parse(markdown).topNode.firstChild;
        node;
        node = node.nextSibling) {
        nodes.push(node);
    }
    return nodes;
}

function quoteMarkdown(markdown) {
    return String(markdown || '')
        .split('\n')
        .map(line => line ? `> ${line}` : '>')
        .join('\n');
}

function parseTranslationResponse(response) {
    const value = String(response || '').trim();
    if (!value) throw new Error('The translated Markdown batch is empty');
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(value);
    try {
        return JSON.parse(fenced ? fenced[1] : value);
    }
    catch {
        throw new Error('The translated Markdown batch is not valid JSON');
    }
}

function estimateMarkdownTokens(markdown) {
    let ascii = 0;
    let nonAscii = 0;
    for (const character of String(markdown || '')) {
        if (character.codePointAt(0) <= 0x7f) ascii++;
        else nonAscii++;
    }
    return Math.ceil(ascii / 4) + nonAscii;
}
