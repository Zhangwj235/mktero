import { WidgetType } from '@codemirror/view';
import { parseGFMTableRow } from '../markdown/markdown-tables.js';
import {
    appendRenderedMarkdown,
    installRenderedImagePreview,
    openRenderedLink,
} from './rendered-markdown-dom.js';
import { installRenderedAnnotations } from './pdf-annotations.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export class RenderedTableWidget extends WidgetType {
    constructor({
        source,
        annotationSource,
        annotationSourceFrom,
        caption,
        resolveImageURL,
        openLink,
        openImagePreview,
        renderVersion,
        highlighted = false,
        annotations = [],
        correctionBlock = null,
        correctionEnabled = false,
        corrected = false,
        commitCorrection,
        restoreCorrection,
        onCorrectionError,
        onCorrectionEditingChange,
        translate,
    }) {
        super();
        this.source = source;
        this.annotationSource = annotationSource;
        this.annotationSourceFrom = annotationSourceFrom;
        this.caption = caption;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
        this.openImagePreview = openImagePreview;
        this.renderVersion = renderVersion;
        this.highlighted = highlighted;
        this.annotations = annotations;
        this.annotationKey = JSON.stringify(annotations);
        this.correctionBlock = correctionBlock;
        this.correctionEnabled = correctionEnabled;
        this.corrected = corrected;
        this.commitCorrection = commitCorrection;
        this.restoreCorrection = restoreCorrection;
        this.onCorrectionError = onCorrectionError;
        this.onCorrectionEditingChange = onCorrectionEditingChange;
        this.translate = translate;
        this.activeCellEdits = 0;
    }

    eq(other) {
        return this.source === other.source
            && this.annotationSource === other.annotationSource
            && this.annotationSourceFrom === other.annotationSourceFrom
            && this.caption?.text === other.caption?.text
            && this.renderVersion === other.renderVersion
            && this.highlighted === other.highlighted
            && this.annotationKey === other.annotationKey
            && this.correctionBlock?.id === other.correctionBlock?.id
            && this.correctionEnabled === other.correctionEnabled
            && this.corrected === other.corrected;
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const container = createHTMLNode(document, 'div');
        container.className = [
            'cm-mktero-rendered',
            'cm-mktero-table',
            this.highlighted ? 'cm-mktero-table-target-highlight' : '',
            this.corrected ? 'cm-mktero-corrected-block' : '',
        ].filter(Boolean).join(' ');
        container.dataset.markdownFrom = String(this.annotationSourceFrom);
        container.dataset.markdownTo = String(
            this.annotationSourceFrom + this.annotationSource.length
        );
        appendRenderedMarkdown(
            container,
            this.source,
            this.resolveImageURL,
            false,
            this.translate
        );
        const table = container.querySelector('table');
        if (table && this.caption) {
            table.prepend(createTableCaption(document, this.caption));
        }
        this.#configureCells(container);
        installRenderedAnnotations(
            container,
            this.annotations,
            this.translate,
            {
                source: this.annotationSource,
                sourceFrom: this.annotationSourceFrom,
            }
        );
        container.addEventListener('mousedown', event => {
            if (event.target?.closest?.('img')) return;
            openRenderedLink(event, this.openLink);
        });
        installRenderedImagePreview(
            container,
            this.openImagePreview,
            this.translate
        );
        if (this.corrected) this.#appendRestoreButton(container);
        return container;
    }

    ignoreEvent(event) {
        if (this.correctionEnabled && this.correctionBlock) return true;
        if (event.type === 'mousedown'
            && event.target?.closest?.('.cm-mktero-pdf-annotation')) {
            return true;
        }
        return !event.target?.closest?.('.cm-mktero-pdf-annotation');
    }

    #configureCells(container) {
        const cells = [...container.querySelectorAll('th, td')];
        for (const cell of cells) setCellReadOnly(cell, true);
        if (!this.correctionEnabled || !this.correctionBlock) return;
        const model = parseGFMTable(this.source);
        if (!model) return;
        const columnCount = model.header.length;
        const values = [model.header, ...model.body].flat();
        cells.forEach((cell, index) => {
            this.#configureCell(cell, {
                model,
                values,
                index,
                columnCount,
            });
        });
    }

    #configureCell(cell, { model, values, index, columnCount }) {
        cell.setAttribute('tabindex', '0');
        cell.setAttribute('spellcheck', 'false');
        let editing = false;
        let originalNodes = [];
        const finishEditing = () => {
            if (!editing) return false;
            editing = false;
            setCellReadOnly(cell, true);
            this.#changeActiveCellEdits(-1);
            return true;
        };
        const begin = () => {
            if (editing) return;
            editing = true;
            originalNodes = [...cell.childNodes].map(node => (
                node.cloneNode(true)
            ));
            cell.textContent = values[index] || '';
            setCellReadOnly(cell, false);
            this.#changeActiveCellEdits(1);
            cell.focus();
        };
        const cancel = () => {
            if (!finishEditing()) return;
            cell.replaceChildren(...originalNodes);
            cell.focus();
        };
        const commit = () => {
            if (!finishEditing()) return;
            const nextValue = normalizeCellValue(cell.textContent);
            if (nextValue === values[index]) {
                cell.replaceChildren(...originalNodes);
                return;
            }
            const replacementMarkdown = serializeTableCellChange({
                model,
                values,
                index,
                nextValue,
                columnCount,
            });
            Promise.resolve().then(() => this.commitCorrection?.({
                blockID: this.correctionBlock.id,
                replacementMarkdown,
            })).then(() => {
                values[index] = nextValue;
            }).catch(error => {
                cell.replaceChildren(...originalNodes);
                this.onCorrectionError?.(error);
            });
        };
        cell.addEventListener('dblclick', event => {
            if (event.target?.closest?.('img')) return;
            event.preventDefault();
            event.stopPropagation();
            begin();
        });
        cell.addEventListener('blur', commit);
        cell.addEventListener('keydown', event => {
            if (!editing && ['Enter', 'F2'].includes(event.key)) {
                event.preventDefault();
                begin();
                return;
            }
            if (editing && event.key === 'Escape') {
                event.preventDefault();
                cancel();
                return;
            }
            if (editing
                && event.key === 'Enter'
                && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                commit();
            }
        });
    }

    #changeActiveCellEdits(delta) {
        const wasEditing = this.activeCellEdits > 0;
        this.activeCellEdits = Math.max(0, this.activeCellEdits + delta);
        const isEditing = this.activeCellEdits > 0;
        if (wasEditing !== isEditing) {
            this.onCorrectionEditingChange?.(isEditing);
        }
    }

    #appendRestoreButton(container) {
        const button = createHTMLNode(container.ownerDocument, 'button');
        button.type = 'button';
        button.className = 'cm-mktero-correction-marker';
        button.textContent = this.translate('revision.restoreBlock');
        button.setAttribute(
            'aria-label',
            this.translate('revision.restoreBlockLabel')
        );
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            button.disabled = true;
            Promise.resolve(this.restoreCorrection?.(this.correctionBlock.id))
                .catch(error => this.onCorrectionError?.(error))
                .finally(() => { button.disabled = false; });
        });
        container.append(button);
    }

    destroy() {
        if (this.activeCellEdits > 0) {
            this.activeCellEdits = 0;
            this.onCorrectionEditingChange?.(false);
        }
    }
}

export function createTableCaption(document, caption) {
    const element = createHTMLNode(document, 'caption');
    const label = createHTMLNode(document, 'span');
    label.className = 'mktero-table-label';
    label.textContent = caption.label;
    element.append(label, ` ${caption.description}`);
    return element;
}

function parseGFMTable(source) {
    const lines = String(source).trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const header = parseGFMTableRow(lines[0]);
    const separator = parseGFMTableRow(lines[1]);
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
        const row = parseGFMTableRow(line);
        while (row.length < header.length) row.push('');
        return row.slice(0, header.length);
    });
    return { header, alignment, body };
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

function normalizeCellValue(value) {
    return String(value || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function escapeTableCell(value) {
    return String(value)
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/(?<!\\)\|/g, '\\|');
}

function serializeTableCellChange({
    model,
    values,
    index,
    nextValue,
    columnCount,
}) {
    const nextValues = [...values];
    nextValues[index] = nextValue;
    const nextModel = {
        ...model,
        header: nextValues.slice(0, columnCount),
        body: [],
    };
    for (let offset = columnCount;
        offset < nextValues.length;
        offset += columnCount) {
        nextModel.body.push(nextValues.slice(offset, offset + columnCount));
    }
    return serializeGFMTable(nextModel);
}

function setCellReadOnly(cell, readOnly) {
    cell.setAttribute('contenteditable', readOnly ? 'false' : 'true');
    cell.setAttribute('aria-readonly', readOnly ? 'true' : 'false');
}

function createHTMLNode(document, tagName) {
    if (typeof document.createElementNS === 'function') {
        return document.createElementNS(XHTML_NAMESPACE, tagName);
    }
    return document.createElement(tagName);
}
