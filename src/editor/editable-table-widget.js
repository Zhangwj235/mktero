import { WidgetType } from '@codemirror/view';
import {
    appendRenderedMarkdown,
    installRenderedImagePreview,
    openRenderedLink,
} from './rendered-markdown-dom.js';
import { runSaveShortcut } from './editor-commands.js';
import { registerTableCellCommandHandler } from './table-cell-commands.js';

export class EditableTableWidget extends WidgetType {
    constructor({
        source,
        from,
        to,
        resolveImageURL,
        openLink,
        openImagePreview,
        onSaveRequest,
        renderVersion,
    }) {
        super();
        this.source = source;
        this.from = from;
        this.to = to;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
        this.openImagePreview = openImagePreview;
        this.onSaveRequest = onSaveRequest;
        this.renderVersion = renderVersion;
    }

    eq(other) {
        return this.source === other.source
            && this.from === other.from
            && this.to === other.to
            && this.renderVersion === other.renderVersion;
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const container = document.createElement('div');
        container.className = 'cm-mktero-rendered cm-mktero-table';
        appendRenderedMarkdown(container, this.source, this.resolveImageURL);
        const tableModel = parseGFMTable(this.source);
        const table = container.querySelector('table');
        if (!tableModel || !table) return container;

        const columnCount = tableModel.header.length;
        const values = [tableModel.header, ...tableModel.body].flat();
        const cells = [...table.querySelectorAll('th, td')];
        cells.forEach((cell, index) => {
            cell.setAttribute('contenteditable', 'false');
            cell.setAttribute('tabindex', '0');
            cell.setAttribute('spellcheck', 'false');
            let editing = false;
            let valueBeforeEditing = values[index] || '';
            let renderedBeforeEditing = null;
            const commitEdit = () => {
                const nextValue = (cell.textContent || '')
                    .replace(/\r?\n/g, '<br>')
                    .trim();
                if (nextValue === valueBeforeEditing) {
                    if (renderedBeforeEditing) {
                        cell.replaceChildren(...renderedBeforeEditing);
                    }
                    return;
                }

                values[index] = nextValue;
                tableModel.header = values.slice(0, columnCount);
                tableModel.body = [];
                for (let offset = columnCount;
                    offset < values.length;
                    offset += columnCount) {
                    tableModel.body.push(values.slice(offset, offset + columnCount));
                }
                view.dispatch({
                    changes: {
                        from: this.from,
                        to: this.to,
                        insert: serializeGFMTable(tableModel),
                    },
                });
            };
            const beginEdit = () => {
                if (editing) return;
                editing = true;
                valueBeforeEditing = values[index] || '';
                renderedBeforeEditing = [...cell.childNodes]
                    .map(node => node.cloneNode(true));
                cell.textContent = valueBeforeEditing;
                cell.setAttribute('contenteditable', 'true');
                cell.focus();
            };
            const cancelEdit = () => {
                if (!editing) return;
                if (renderedBeforeEditing) {
                    cell.replaceChildren(...renderedBeforeEditing);
                }
                editing = false;
                cell.setAttribute('contenteditable', 'false');
                cell.focus();
            };
            cell.addEventListener('dblclick', event => {
                if (event.target?.closest?.('img')) return;
                event.preventDefault();
                event.stopPropagation();
                beginEdit();
            });
            registerTableCellCommandHandler(cell, commitEdit);
            cell.addEventListener('blur', () => {
                if (!editing) return;
                commitEdit();
                editing = false;
                cell.setAttribute('contenteditable', 'false');
            });
            cell.addEventListener('keydown', event => {
                if (!editing && ['Enter', 'F2'].includes(event.key)) {
                    event.preventDefault();
                    beginEdit();
                    return;
                }
                if (editing && event.key === 'Escape') {
                    event.preventDefault();
                    cancelEdit();
                    return;
                }
                runSaveShortcut(
                    event,
                    () => view.state.doc.toString(),
                    this.onSaveRequest,
                    commitEdit
                );
            });
        });
        container.addEventListener('mousedown', event => {
            if (event.target?.closest?.('img')) return;
            openRenderedLink(event, this.openLink);
        });
        installRenderedImagePreview(container, this.openImagePreview);
        return container;
    }

    ignoreEvent() {
        return true;
    }
}

function parseGFMTable(source) {
    const lines = source.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const header = parseTableRow(lines[0]);
    const separator = parseTableRow(lines[1]);
    if (!header.length || separator.length !== header.length) return null;
    const alignment = separator.map(cell => {
        const value = cell.trim();
        if (!/^:?-{3,}:?$/.test(value)) return null;
        if (value.startsWith(':') && value.endsWith(':')) return 'center';
        if (value.endsWith(':')) return 'right';
        if (value.startsWith(':')) return 'left';
        return 'none';
    });
    if (alignment.includes(null)) return null;

    const body = lines.slice(2).map(line => {
        const cells = parseTableRow(line);
        while (cells.length < header.length) cells.push('');
        return cells.slice(0, header.length);
    });
    return { header, alignment, body };
}

function parseTableRow(line) {
    let source = line.trim();
    if (source.startsWith('|')) source = source.slice(1);
    if (source.endsWith('|') && !source.endsWith('\\|')) {
        source = source.slice(0, -1);
    }
    const cells = [];
    let cell = '';
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\\' && source[index + 1] === '|') {
            cell += '|';
            index++;
        }
        else if (source[index] === '|') {
            cells.push(cell.trim());
            cell = '';
        }
        else {
            cell += source[index];
        }
    }
    cells.push(cell.trim());
    return cells;
}

function serializeGFMTable(table) {
    const formatRow = cells => `| ${cells.map(escapeTableCell).join(' | ')} |`;
    const separator = table.alignment.map(alignment => {
        if (alignment === 'center') return ':---:';
        if (alignment === 'right') return '---:';
        if (alignment === 'left') return ':---';
        return '---';
    });
    return [
        formatRow(table.header),
        formatRow(separator),
        ...table.body.map(formatRow),
    ].join('\n');
}

function escapeTableCell(value) {
    return String(value).replace(/\|/g, '\\|');
}
