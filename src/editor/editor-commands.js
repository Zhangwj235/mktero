import { redo, undo } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import {
    hasActiveTableCell,
    runTableCellCommand,
} from './table-cell-commands.js';
import { hasActiveMarkdownWrapper } from './markdown-wrappers.js';

const LIST_PREFIX_PATTERN = /^(?:- \[[ xX]\]\s+|[-+*]\s+|\d+[.)]\s+)/;

export const EDITOR_TOOLBAR_GROUPS = [
    [
        createCommand('undo', '撤销', [
            ['path', { d: 'M8 7H4V3' }],
            ['path', { d: 'M4 7c2-3 5-4 8-3 3 .8 5 3.5 4.7 6.6S14 16 10.8 16' }],
        ], view => undo(view), { runWhileTableFocused: true }),
        createCommand('redo', '重做', [
            ['path', { d: 'M12 7h4V3' }],
            ['path', { d: 'M16 7c-2-3-5-4-8-3-3 .8-5 3.5-4.7 6.6S6 16 9.2 16' }],
        ], view => redo(view), { runWhileTableFocused: true }),
    ],
    [
        createWrapCommand('bold', '粗体', [
            ['path', { d: 'M6.5 3.5h5a3 3 0 0 1 0 6h-5z' }],
            ['path', { d: 'M6.5 9.5H12a3.5 3.5 0 0 1 0 7h-5.5z' }],
        ], '**', '**', '粗体文字'),
        createWrapCommand('italic', '斜体', [
            ['path', { d: 'M9 3.5h7M4 16.5h7M13 3.5l-5 13' }],
        ], '*', '*', '斜体文字'),
    ],
    [
        createWrapCommand('link', '链接', [
            ['path', { d: 'm8.2 12.8-1.4 1.4a3 3 0 0 1-4.2-4.2l2.8-2.8a3 3 0 0 1 4.2 0' }],
            ['path', { d: 'm11.8 7.2 1.4-1.4a3 3 0 0 1 4.2 4.2l-2.8 2.8a3 3 0 0 1-4.2 0M7 10h6' }],
        ], '[', '](https://)', '链接文字'),
        createWrapCommand('code', '行内代码', [
            ['path', { d: 'm7 5-4 5 4 5M13 5l4 5-4 5M11.5 3.5l-3 13' }],
        ], '`', '`', '代码'),
    ],
    [
        createCommand('bullet-list', '项目符号列表', [
            ['circle', { cx: '4', cy: '5', r: '1' }],
            ['circle', { cx: '4', cy: '10', r: '1' }],
            ['circle', { cx: '4', cy: '15', r: '1' }],
            ['path', { d: 'M8 5h9M8 10h9M8 15h9' }],
        ], view => toggleLinePrefix(view, '- ', LIST_PREFIX_PATTERN)),
        createCommand('numbered-list', '编号列表', [
            ['path', { d: 'M3 4h1v3M3 7h2M3 10h2l-2 3h2M8 5h9M8 10h9M8 15h9' }],
        ], view => toggleLinePrefix(view, '1. ', LIST_PREFIX_PATTERN)),
        createCommand('task-list', '任务列表', [
            ['rect', { x: '2.5', y: '3.5', width: '4', height: '4', rx: '.5' }],
            ['rect', { x: '2.5', y: '12.5', width: '4', height: '4', rx: '.5' }],
            ['path', { d: 'm3.5 5.5 1 1 2-3M9 5.5h8M9 14.5h8' }],
        ], view => toggleLinePrefix(view, '- [ ] ', LIST_PREFIX_PATTERN)),
    ],
    [
        createCommand('heading', '二级标题', [
            ['path', { d: 'M3 4v12M11 4v12M3 10h8M14 8.5c.7-1 3-1 3 1 0 1.5-3 2.5-3 5h3.5' }],
        ], view => toggleLinePrefix(view, '## ', /^#{1,6}\s+/)),
        createCommand('horizontal-rule', '水平分隔线', [
            ['path', { d: 'M2.5 10h15' }],
            ['circle', { cx: '5', cy: '5', r: '.8' }],
            ['circle', { cx: '10', cy: '5', r: '.8' }],
            ['circle', { cx: '15', cy: '5', r: '.8' }],
        ], view => insertBlock(view, '---')),
        createCommand('table', '插入表格', [
            ['rect', { x: '2.5', y: '3.5', width: '15', height: '13', rx: '1' }],
            ['path', { d: 'M2.5 8h15M2.5 12.5h15M7.5 3.5v13M12.5 3.5v13' }],
        ], view => insertBlock(view, [
            '| 列 1 | 列 2 |',
            '| --- | --- |',
            '|  |  |',
        ].join('\n'))),
    ],
];

const EDITOR_COMMANDS = new Map(
    EDITOR_TOOLBAR_GROUPS.flat().map(command => [command.command, command])
);

export function runSaveShortcut(event, getMarkdown, onSaveRequest, beforeSave) {
    if (event.key?.toLowerCase() !== 's'
        || (!event.metaKey && !event.ctrlKey)) return false;
    event.preventDefault();
    beforeSave?.();
    onSaveRequest?.(getMarkdown());
    return true;
}

export function runEditorCommand(view, command) {
    const descriptor = EDITOR_COMMANDS.get(command);
    if (!descriptor) return false;
    if (hasActiveTableCell(view.root)) {
        if (descriptor.cellWrapper) {
            return runTableCellCommand(
                view.root,
                descriptor.cellWrapper
            );
        }
        if (!descriptor.runWhileTableFocused) return false;
        runTableCellCommand(view.root, null);
    }
    return descriptor.run(view) !== false;
}

function createCommand(command, label, icon, run, options = {}) {
    return { command, label, icon, run, ...options };
}

function createWrapCommand(
    command,
    label,
    icon,
    opening,
    closing,
    placeholder
) {
    const cellWrapper = { opening, closing, placeholder };
    return {
        ...createCommand(
            command,
            label,
            icon,
            view => wrapSelection(view, opening, closing, placeholder)
        ),
        cellWrapper,
    };
}

function wrapSelection(view, opening, closing, placeholder) {
    view.dispatch(view.state.changeByRange(range => {
        const openingFrom = range.from - opening.length;
        const closingTo = range.to + closing.length;
        const alreadyWrapped = hasActiveMarkdownWrapper(
            {
                length: view.state.doc.length,
                slice: (from, to) => view.state.sliceDoc(from, to),
            },
            range.from,
            range.to,
            opening,
            closing
        );
        if (alreadyWrapped) {
            return {
                changes: [
                    { from: openingFrom, to: range.from, insert: '' },
                    { from: range.to, to: closingTo, insert: '' },
                ],
                range: EditorSelection.range(
                    openingFrom,
                    range.to - opening.length
                ),
            };
        }
        const selected = view.state.sliceDoc(range.from, range.to);
        const content = selected || placeholder;
        const insert = `${opening}${content}${closing}`;
        const from = range.from + opening.length;
        return {
            changes: { from: range.from, to: range.to, insert },
            range: EditorSelection.range(from, from + content.length),
        };
    }));
    view.focus();
}

function toggleLinePrefix(view, prefix, existingPrefixPattern) {
    const lines = selectedLines(view.state);
    const removePrefix = lines.every(line => line.text.startsWith(prefix));
    const changes = lines.map(line => {
        if (removePrefix) {
            return { from: line.from, to: line.from + prefix.length, insert: '' };
        }
        const existing = existingPrefixPattern.exec(line.text)?.[0] || '';
        return {
            from: line.from,
            to: line.from + existing.length,
            insert: prefix,
        };
    });
    view.dispatch({ changes });
    view.focus();
}

function selectedLines(state) {
    const lines = new Map();
    for (const range of state.selection.ranges) {
        const selectionEndsAtLineStart = range.to > range.from
            && state.doc.lineAt(range.to).from === range.to;
        const end = selectionEndsAtLineStart ? range.to - 1 : range.to;
        const firstLine = state.doc.lineAt(range.from).number;
        const lastLine = state.doc.lineAt(end).number;
        for (let number = firstLine; number <= lastLine; number++) {
            const line = state.doc.line(number);
            lines.set(number, line);
        }
    }
    return [...lines.values()];
}

function insertBlock(view, block) {
    view.dispatch(view.state.changeByRange(range => {
        const prefix = range.from > 0
            && view.state.sliceDoc(range.from - 1, range.from) !== '\n'
            ? '\n\n'
            : '';
        const suffix = range.to < view.state.doc.length
            && view.state.sliceDoc(range.to, range.to + 1) !== '\n'
            ? '\n\n'
            : '';
        const insert = `${prefix}${block}${suffix}`;
        const cursor = range.from + prefix.length + block.length;
        return {
            changes: { from: range.from, to: range.to, insert },
            range: EditorSelection.cursor(cursor),
        };
    }));
    view.focus();
}
