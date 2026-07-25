import { WidgetType } from '@codemirror/view';
import {
    appendRenderedMarkdown,
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
        onSaveRequest,
        renderVersion,
    }) {
        super();
        this.source = source;
        this.from = from;
        this.to = to;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
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
            cell.setAttribute('contenteditable', 'true');
            cell.setAttribute('spellcheck', 'false');
            let valueBeforeEditing = values[index] || '';
            let renderedBeforeEditing = null;
            cell.addEventListener('focus', () => {
                valueBeforeEditing = values[index] || '';
                renderedBeforeEditing = [...cell.childNodes]
                    .map(node => node.cloneNode(true));
                cell.textContent = valueBeforeEditing;
            });
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
            registerTableCellCommandHandler(cell, commitEdit);
            cell.addEventListener('blur', commitEdit);
            cell.addEventListener('keydown', event => {
                runSaveShortcut(
                    event,
                    () => view.state.doc.toString(),
                    this.onSaveRequest,
                    commitEdit
                );
            });
        });
        container.addEventListener('mousedown', event => {
            openRenderedLink(event, this.openLink);
        });
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
