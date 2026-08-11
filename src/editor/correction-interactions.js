const CORRECTION_INTERACTION_SELECTOR = [
    'a',
    'button',
    'input',
    'textarea',
    'select',
    'img',
    '[role="button"]',
    '.cm-mktero-link',
    '.cm-mktero-citation',
    '.cm-mktero-table-reference',
    '.cm-mktero-figure-reference',
    '.cm-mktero-pdf-annotation',
    '.cm-mktero-pdf-annotation-note',
    '.cm-mktero-translation',
].join(', ');

export function isCorrectionInteractionTarget(target) {
    return Boolean(target?.closest?.(CORRECTION_INTERACTION_SELECTOR));
}

export function isEditableTextCorrectionBlock(block) {
    return Boolean(block
        && ['heading', 'paragraph'].includes(block.type));
}
