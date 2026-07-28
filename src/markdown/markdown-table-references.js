import { parser as markdownParser } from '@lezer/markdown';
import { findAcademicTableGroups } from './markdown-figures.js';

const TABLE_IDENTIFIER_SOURCE = '(?:s?\\d{1,4}[a-z]?|[ivxlcdm]{1,12}[a-z]?)';
const TABLE_LABEL_PATTERN = new RegExp(
    `^table[ \\t]+(${TABLE_IDENTIFIER_SOURCE})`,
    'iu'
);
const TABLE_REFERENCE_PATTERN = new RegExp(
    `\\btable[ \\t]+(${TABLE_IDENTIFIER_SOURCE})\\b`,
    'giu'
);
const IGNORED_REFERENCE_NODES = new Set([
    'InlineCode',
    'FencedCode',
    'CodeBlock',
    'Image',
    'Link',
    'Autolink',
    'URL',
    'HTMLBlock',
]);

export function analyzeMarkdownTableReferences(markdown) {
    const source = String(markdown || '');
    const groups = findAcademicTableGroups(source);
    const candidates = groups.flatMap(group => {
        const key = tableKey(group.caption.label);
        return key ? [{ key, group }] : [];
    });
    const candidatesByKey = new Map();
    for (const candidate of candidates) {
        const matches = candidatesByKey.get(candidate.key) || [];
        matches.push(candidate);
        candidatesByKey.set(candidate.key, matches);
    }
    const targets = candidates.flatMap(candidate => (
        candidatesByKey.get(candidate.key)?.length === 1
            ? [tableTarget(candidate.key, candidate.group)]
            : []
    ));
    const targetsByKey = new Map(targets.map(target => [target.key, target]));
    const ignoredRanges = [
        ...groups,
        ...ignoredReferenceRanges(source),
    ];
    const references = [];

    for (const match of source.matchAll(new RegExp(TABLE_REFERENCE_PATTERN))) {
        const target = targetsByKey.get(normalizeIdentifier(match[1]));
        if (!target
            || ignoredRanges.some(range => rangeContains(range, match.index))) {
            continue;
        }
        references.push({
            from: match.index,
            to: match.index + match[0].length,
            targetId: target.id,
        });
    }

    return { targets, references };
}

function ignoredReferenceRanges(markdown) {
    const ranges = [];
    markdownParser.parse(markdown).iterate({
        enter(node) {
            if (!IGNORED_REFERENCE_NODES.has(node.name)) return undefined;
            ranges.push({ from: node.from, to: node.to });
            return false;
        },
    });
    return ranges;
}

function tableTarget(key, group) {
    return {
        id: `table:${key}`,
        key,
        label: group.caption.label,
        caption: group.caption.text,
        from: group.from,
        to: group.to,
        table: group.table,
    };
}

function tableKey(label) {
    const match = TABLE_LABEL_PATTERN.exec(String(label || ''));
    return match ? normalizeIdentifier(match[1]) : '';
}

function normalizeIdentifier(identifier) {
    return String(identifier || '').toLowerCase();
}

function rangeContains(range, position) {
    return position >= range.from && position < range.to;
}
