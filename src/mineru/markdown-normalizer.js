const BLANK_LINE_SEPARATOR = /(\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*)/;
const BLOCK_START_PATTERN = /^(?: {0,3}(?:#{1,6}(?:[ \t]|$)|>|(?:[-+*]|\d+[.)])[ \t]+|```|~~~)| {4}\S|\t\S|<|\$\$|\\\[|\\begin\{|\[[^\]\n]+\]:)/;
const TABLE_SEPARATOR_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?$/m;
const SETEXT_HEADING_PATTERN = /\r?\n[ \t]*(?:=+|-+)[ \t]*$/;
const CAPTION_START_PATTERN = /^(?:algorithm|chart|fig\.?|figure|scheme|table)[ \t]+(?:[a-z]?\d+[a-z]?|[ivxlcdm]+[a-z]?)\b/i;
const PUBLICATION_METADATA_PATTERN = /^(?:doi|isbn|issn|pmcid?|url)\s*:/i;
const REFERENCE_HEADING_PATTERN = /^(?:#{1,6}[ \t]+)?(?:\*{1,2}|_{1,2})?(?:references?|bibliography|works[ \t]+cited|literature[ \t]+cited|参考文献|参考资料|参考书目)(?:\*{1,2}|_{1,2})?[ \t]*[:：]?[ \t]*#*[ \t]*$/i;
const MIN_PRECEDING_WORDS = 6;

export function normalizeMinerUMarkdown(markdown) {
    if (typeof markdown !== 'string' || !markdown.includes('\n')) return markdown;

    const parts = markdown.split(BLANK_LINE_SEPARATOR);
    if (parts.length < 3) return markdown;

    let output = parts[0];
    let inReferences = isReferenceHeading(parts[0]);
    for (let index = 1; index < parts.length; index += 2) {
        const separator = parts[index];
        const nextBlock = parts[index + 1] || '';
        if (isReferenceHeading(parts[index - 1])) inReferences = true;
        if (!inReferences
            && isBrokenProseBoundary(parts[index - 1], separator, nextBlock)) {
            output = `${output.trimEnd()} ${nextBlock}`;
        }
        else {
            output += separator + nextBlock;
        }
    }
    return output;
}

function isBrokenProseBoundary(previousBlock, separator, nextBlock) {
    if (countLineBreaks(separator) !== 2) return false;

    const previous = previousBlock.trimEnd();
    const next = nextBlock.trimEnd();
    if (!previous.trim() || !next.trim()
        || isMarkdownBlock(previous) || isMarkdownBlock(next)) {
        return false;
    }
    if (!/^\p{Ll}/u.test(next) || !/[\p{L}\p{N}]$/u.test(previous)) {
        return false;
    }

    const words = previous.match(/\p{L}[\p{L}\p{N}'’-]*/gu) || [];
    return words.length >= MIN_PRECEDING_WORDS;
}

function isMarkdownBlock(block) {
    return BLOCK_START_PATTERN.test(block)
        || TABLE_SEPARATOR_PATTERN.test(block)
        || SETEXT_HEADING_PATTERN.test(block)
        || CAPTION_START_PATTERN.test(block)
        || PUBLICATION_METADATA_PATTERN.test(block)
        || isImageOnlyBlock(block);
}

function isReferenceHeading(block) {
    return REFERENCE_HEADING_PATTERN.test(block.trim());
}

function isImageOnlyBlock(block) {
    const lines = block.split(/\r?\n/).filter(line => line.trim());
    return lines.length > 0
        && lines.every(line => /^!\[[^\]\n]*\]\(.+\)[ \t]*$/.test(line.trim()));
}

function countLineBreaks(value) {
    return value.match(/\n/g)?.length || 0;
}
