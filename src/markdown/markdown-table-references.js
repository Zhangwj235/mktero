import { findAcademicTableGroups } from './markdown-figures.js';
import {
    ACADEMIC_REFERENCE_IDENTIFIER_SOURCE,
    analyzeMarkdownLabeledReferences,
    locateMarkdownTargetLabel,
    normalizeReferenceIdentifier,
} from './markdown-reference-analysis.js';

const TABLE_LABEL_PATTERN = new RegExp(
    `^table[ \\t]+(${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE})`,
    'iu'
);
const TABLE_REFERENCE_PATTERN = new RegExp(
    `\\btable[ \\t]+(${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE})\\b`,
    'giu'
);
export function analyzeMarkdownTableReferences(markdown) {
    const source = String(markdown || '');
    const groups = findAcademicTableGroups(source);
    return analyzeMarkdownLabeledReferences(source, {
        objects: groups,
        keyForObject: group => tableKey(group.caption.label),
        createTarget: tableTarget,
        referencePattern: TABLE_REFERENCE_PATTERN,
    });
}

function tableTarget(key, group, markdown) {
    const labelRange = locateMarkdownTargetLabel(markdown, {
        label: group.caption.label,
        caption: group.caption.text,
        from: group.from,
        to: group.to,
        excludedRanges: [group.table],
    });
    return {
        id: `table:${key}`,
        key,
        label: group.caption.label,
        labelFrom: labelRange?.from ?? null,
        labelTo: labelRange?.to ?? null,
        caption: group.caption.text,
        from: group.from,
        to: group.to,
        table: group.table,
    };
}

function tableKey(label) {
    const match = TABLE_LABEL_PATTERN.exec(String(label || ''));
    return match ? normalizeReferenceIdentifier(match[1]) : '';
}
