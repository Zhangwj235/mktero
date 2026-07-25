import { hasActiveMarkdownWrapper } from './markdown-wrappers.js';

const tableCellCommandHandlers = new WeakMap();

export function registerTableCellCommandHandler(cell, commitEdit) {
    tableCellCommandHandlers.set(cell, wrapper => {
        if (!wrapper) {
            commitEdit();
            return true;
        }
        const root = cell.getRootNode();
        const selectionTarget = root.nodeType === 11 && root.getSelection
            ? root
            : cell.ownerDocument;
        const selection = selectionTarget.getSelection?.();
        if (!selection?.rangeCount) return false;
        const range = selection.getRangeAt(0);
        if (!cell.contains(range.commonAncestorContainer)
            && range.commonAncestorContainer !== cell) return false;

        const source = cell.textContent || '';
        const from = textOffsetAt(cell, range.startContainer, range.startOffset);
        const to = textOffsetAt(cell, range.endContainer, range.endOffset);
        const result = toggleTextWrapper(source, from, to, wrapper);
        cell.textContent = result.text;
        commitEdit();
        return true;
    });
}

export function runTableCellCommand(root, wrapper) {
    const handler = tableCellCommandHandlers.get(findActiveElement(root));
    return handler ? handler(wrapper) : false;
}

export function hasActiveTableCell(root) {
    return tableCellCommandHandlers.has(findActiveElement(root));
}

function findActiveElement(root) {
    let activeElement = root.activeElement;
    while (activeElement?.shadowRoot?.activeElement) {
        activeElement = activeElement.shadowRoot.activeElement;
    }
    return activeElement;
}

function textOffsetAt(cell, container, offset) {
    const range = cell.ownerDocument.createRange();
    range.selectNodeContents(cell);
    range.setEnd(container, offset);
    return range.toString().length;
}

function toggleTextWrapper(source, from, to, wrapper) {
    const { opening, closing, placeholder } = wrapper;
    const openingFrom = from - opening.length;
    const closingTo = to + closing.length;
    const wrapped = hasActiveMarkdownWrapper(
        { length: source.length, slice: (start, end) => source.slice(start, end) },
        from,
        to,
        opening,
        closing
    );
    if (wrapped) {
        return {
            text: source.slice(0, openingFrom)
                + source.slice(from, to)
                + source.slice(closingTo),
        };
    }
    const content = source.slice(from, to) || placeholder;
    return {
        text: source.slice(0, from)
            + opening
            + content
            + closing
            + source.slice(to),
    };
}
