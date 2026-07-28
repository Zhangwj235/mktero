import { syntaxTree } from '@codemirror/language';
import { Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
    safeMarkdownLinkURL,
} from '../markdown/markdown-html.js';
import {
    findAcademicFigureGroups,
    findAcademicTableGroups,
} from '../markdown/markdown-figures.js';
import { analyzeMarkdownCitations } from '../markdown/markdown-citations.js';
import { analyzeMarkdownTableReferences } from '../markdown/markdown-table-references.js';
import { EditableTableWidget } from './editable-table-widget.js';
import {
    appendRenderedMarkdown,
    installRenderedCitations,
    installRenderedImagePreview,
    openRenderedLink,
} from './rendered-markdown-dom.js';

const setInlineEditingRange = StateEffect.define();
export const clearInlineEditing = StateEffect.define();
export const setReferenceHighlight = StateEffect.define();
export const setTableHighlight = StateEffect.define();

class RenderedMarkdownWidget extends WidgetType {
    constructor({
        source,
        display,
        from,
        resolveImageURL,
        openLink,
        openImagePreview,
        enterEditing,
        renderVersion,
        citations = [],
        extraClassName = '',
    }) {
        super();
        this.source = source;
        this.display = display;
        this.from = from;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
        this.openImagePreview = openImagePreview;
        this.enterEditing = enterEditing;
        this.renderVersion = renderVersion;
        this.citations = citations;
        this.citationKey = citations.map(citation => citation.key).join('|');
        this.extraClassName = extraClassName;
    }

    eq(other) {
        return this.source === other.source
            && this.display === other.display
            && this.from === other.from
            && this.renderVersion === other.renderVersion
            && this.citationKey === other.citationKey
            && this.extraClassName === other.extraClassName;
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const inline = ['inline', 'image-inline', 'math'].includes(this.display);
        const container = document.createElement(inline ? 'span' : 'div');
        container.className = [
            'cm-mktero-rendered',
            `cm-mktero-${this.display}`,
            this.extraClassName,
        ].filter(Boolean).join(' ');
        appendRenderedMarkdown(
            container,
            this.source,
            this.resolveImageURL,
            inline
        );
        installRenderedCitations(container, this.citations);

        container.addEventListener('mousedown', event => {
            if (event.target?.closest?.('img')) return;
            openRenderedLink(event, this.openLink);
        });
        installRenderedImagePreview(container, this.openImagePreview);
        container.addEventListener('dblclick', event => {
            if (event.target?.closest?.('img')) return;
            if (event.target?.closest?.('a[href]')) return;
            if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            this.enterEditing?.(view);
            view.dispatch({
                selection: { anchor: this.from },
                effects: setInlineEditingRange.of({
                    from: this.from,
                    to: this.from + this.source.length,
                }),
            });
            view.focus();
        });
        return container;
    }

    ignoreEvent(event) {
        return !event.target?.closest?.('.cm-mktero-citation');
    }
}

class TextMarkerWidget extends WidgetType {
    constructor(text, className) {
        super();
        this.text = text;
        this.className = className;
    }

    eq(other) {
        return this.text === other.text && this.className === other.className;
    }

    toDOM(view) {
        const marker = view.dom.ownerDocument.createElement('span');
        marker.className = this.className;
        marker.textContent = this.text;
        return marker;
    }
}

class TaskCheckboxWidget extends WidgetType {
    constructor({ checked, from, to }) {
        super();
        this.checked = checked;
        this.from = from;
        this.to = to;
    }

    eq(other) {
        return this.checked === other.checked
            && this.from === other.from
            && this.to === other.to;
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const wrapper = document.createElement('span');
        wrapper.className = 'cm-mktero-task';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.checked;
        checkbox.setAttribute('aria-label', 'Toggle Markdown task');
        checkbox.addEventListener('change', () => {
            view.dispatch({
                changes: {
                    from: this.from,
                    to: this.to,
                    insert: checkbox.checked ? '[x]' : '[ ]',
                },
            });
        });
        wrapper.appendChild(checkbox);
        return wrapper;
    }

    ignoreEvent() {
        return true;
    }
}

export function createInlineRenderingExtension({
    resolveImageURL,
    openLink,
    onSaveRequest,
    openImagePreview,
    citationPopup,
    tablePreviewPopup,
    activateCitation,
    activateTableReference,
    enterEditing,
    exitEditing,
}) {
    const context = {
        resolveImageURL,
        openLink,
        onSaveRequest,
        openImagePreview,
        citationPopup,
        tablePreviewPopup,
        activateCitation,
        activateTableReference,
        enterEditing,
        exitEditing,
        renderVersion: 0,
        editingRange: null,
        highlightedReferenceID: null,
        highlightedTableID: null,
        citationAnalysisDocument: null,
        citationAnalysis: null,
        citationTargets: new Map(),
        tableReferenceAnalysisDocument: null,
        tableReferenceAnalysis: null,
        tableTargets: new Map(),
    };
    const renderingField = StateField.define({
        create(state) {
            return buildDecorations(state, context);
        },
        update(decorations, transaction) {
            const shouldRefresh = transaction.effects.some(effect => (
                effect.is(refreshInlineRendering)
            ));
            let editingRangeChanged = false;
            let referenceHighlightChanged = false;
            let tableHighlightChanged = false;
            if (shouldRefresh) context.renderVersion++;
            if (transaction.docChanged && context.editingRange) {
                context.editingRange = {
                    from: transaction.changes.mapPos(context.editingRange.from, -1),
                    to: transaction.changes.mapPos(context.editingRange.to, 1),
                };
            }
            for (const effect of transaction.effects) {
                if (effect.is(setInlineEditingRange)) {
                    context.editingRange = effect.value;
                    editingRangeChanged = true;
                }
                else if (effect.is(clearInlineEditing)) {
                    context.editingRange = null;
                    editingRangeChanged = true;
                }
                else if (effect.is(setReferenceHighlight)) {
                    context.highlightedReferenceID = effect.value;
                    referenceHighlightChanged = true;
                }
                else if (effect.is(setTableHighlight)) {
                    context.highlightedTableID = effect.value;
                    tableHighlightChanged = true;
                }
            }
            if (transaction.docChanged
                || editingRangeChanged
                || referenceHighlightChanged
                || tableHighlightChanged
                || shouldRefresh) {
                return buildDecorations(transaction.state, context);
            }
            return decorations;
        },
        provide: field => EditorView.decorations.from(field),
    });
    return [
        renderingField,
        Prec.highest(EditorView.domEventHandlers({
            mouseover(event, view) {
                const citation = citationElement(event, view);
                if (citation) {
                    openCitationPopup(citation, view, context);
                    return false;
                }
                const tableReference = tableReferenceElement(event, view);
                if (tableReference) {
                    openTablePreviewPopup(tableReference, context);
                }
                return false;
            },
            mouseout(event, view) {
                const citation = citationElement(event, view);
                if (citation) {
                    if (citation.contains(event.relatedTarget)
                        || context.citationPopup?.contains(event.relatedTarget)) {
                        return false;
                    }
                    context.citationPopup?.scheduleClose();
                    return false;
                }
                const tableReference = tableReferenceElement(event, view);
                if (!tableReference) return false;
                if (tableReference.contains(event.relatedTarget)
                    || context.tablePreviewPopup?.contains(event.relatedTarget)) {
                    return false;
                }
                context.tablePreviewPopup?.scheduleClose();
                return false;
            },
            focusin(event, view) {
                const citation = citationElement(event, view);
                if (citation) {
                    openCitationPopup(citation, view, context);
                    return false;
                }
                const tableReference = tableReferenceElement(event, view);
                if (tableReference) {
                    openTablePreviewPopup(tableReference, context);
                }
                return false;
            },
            focusout(event, view) {
                const citation = citationElement(event, view);
                if (citation) {
                    context.citationPopup?.scheduleClose();
                    return false;
                }
                if (tableReferenceElement(event, view)) {
                    context.tablePreviewPopup?.scheduleClose();
                }
                return false;
            },
            mousedown(event, view) {
                if (event.button === 0
                    && (citationElement(event, view)
                        || tableReferenceElement(event, view))) {
                    event.preventDefault();
                    return true;
                }
                if (event.button !== 0 || (!event.metaKey && !event.ctrlKey)) {
                    return false;
                }
                const link = event.target?.closest?.('.cm-mktero-link');
                if (!link || !view.dom.contains(link)) return false;

                const position = view.posAtDOM(link, 0);
                const url = safeMarkdownLinkURL(findLinkURL(view.state, position));
                if (!url) return false;
                event.preventDefault();
                openLink?.(url);
                return true;
            },
            click(event, view) {
                const citation = citationElement(event, view);
                if (citation && event.button === 0) {
                    event.preventDefault();
                    activateCitationElement(citation, view, context);
                    return true;
                }
                const tableReference = tableReferenceElement(event, view);
                if (tableReference && event.button === 0) {
                    event.preventDefault();
                    activateTableReferenceElement(
                        tableReference,
                        view,
                        context
                    );
                    return true;
                }
                if (!context.editingRange || event.button !== 0) return false;
                const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (position === null || positionInsideRange(position, context.editingRange)) {
                    return false;
                }
                view.dispatch({ effects: setInlineEditingRange.of(null) });
                context.exitEditing?.(view);
                return false;
            },
            dblclick(event, view) {
                if (citationElement(event, view)
                    || tableReferenceElement(event, view)) {
                    event.preventDefault();
                    return true;
                }
                if (event.button !== 0 || event.target?.closest?.('img')) return false;
                const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (position === null) return false;
                const line = view.state.doc.lineAt(position);
                event.preventDefault();
                context.enterEditing?.(view);
                view.dispatch({
                    selection: { anchor: position },
                    effects: setInlineEditingRange.of({ from: line.from, to: line.to }),
                });
                view.focus();
                return true;
            },
            keydown(event, view) {
                const citation = citationElement(event, view);
                if (citation) {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        openCitationPopup(citation, view, context, true);
                        return true;
                    }
                    if (!['Enter', ' '].includes(event.key)) return false;
                    event.preventDefault();
                    activateCitationElement(citation, view, context);
                    return true;
                }
                const tableReference = tableReferenceElement(event, view);
                if (!tableReference
                    || !['Enter', ' '].includes(event.key)) {
                    return false;
                }
                event.preventDefault();
                activateTableReferenceElement(tableReference, view, context);
                return true;
            },
            blur(event, view) {
                if (!context.citationPopup?.contains(event.relatedTarget)) {
                    context.citationPopup?.close();
                }
                if (!context.tablePreviewPopup?.contains(event.relatedTarget)) {
                    context.tablePreviewPopup?.close();
                }
                if (context.editingRange) {
                    view.dispatch({ effects: setInlineEditingRange.of(null) });
                }
                context.exitEditing?.(view);
                return false;
            },
        })),
    ];
}

export const refreshInlineRendering = StateEffect.define();

function findLinkURL(state, position) {
    let node = syntaxTree(state).resolveInner(position, 1);
    while (node && !['Link', 'Autolink', 'URL'].includes(node.name)) {
        node = node.parent;
    }
    if (node?.name === 'URL') return state.sliceDoc(node.from, node.to);
    const urlNode = node?.getChild('URL');
    if (urlNode) return state.sliceDoc(urlNode.from, urlNode.to);
    if (node?.name !== 'Link') return '';

    const label = node.getChild('LinkLabel');
    let normalizedLabel = label
        ? normalizeLinkLabel(state.sliceDoc(label.from, label.to))
        : '';
    if (!normalizedLabel) {
        const marks = node.getChildren('LinkMark');
        const closingLabel = marks.find(mark => (
            state.sliceDoc(mark.from, mark.to) === ']'
        ));
        if (marks.length && closingLabel) {
            normalizedLabel = normalizeLinkLabel(
                state.sliceDoc(marks[0].to, closingLabel.from)
            );
        }
    }
    if (!normalizedLabel) return '';
    let resolvedURL = '';
    syntaxTree(state).iterate({
        enter(reference) {
            if (resolvedURL || reference.name !== 'LinkReference') return;
            const referenceLabel = reference.node.getChild('LinkLabel');
            const referenceURL = reference.node.getChild('URL');
            if (referenceLabel && referenceURL
                && normalizeLinkLabel(
                    state.sliceDoc(referenceLabel.from, referenceLabel.to)
                ) === normalizedLabel) {
                resolvedURL = state.sliceDoc(referenceURL.from, referenceURL.to);
            }
        },
    });
    return resolvedURL;
}

function normalizeLinkLabel(label) {
    return String(label)
        .replace(/^\[|\]$/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function positionInsideRange(position, range) {
    return position >= range.from && position <= range.to;
}

function buildDecorations(state, context) {
    const decorations = [];
    const excludedMathRanges = collectExcludedMathRanges(state);
    const analyzedTableReferences = tableReferenceAnalysis(state, context);
    const tableTargetsByFrom = new Map(
        analyzedTableReferences.targets.map(target => [target.from, target])
    );
    const figureGroups = findAcademicFigureGroups(state.doc.toString())
        .filter(group => !editingRangeIntersects(context, group.from, group.to));
    const tableGroups = findAcademicTableGroups(state.doc.toString())
        .filter(group => !editingRangeIntersects(context, group.from, group.to));
    const renderedGroups = [...figureGroups, ...tableGroups];
    for (const group of figureGroups) {
        decorations.push(renderedRange(group, state, 'image', context));
    }
    for (const group of tableGroups) {
        decorations.push(renderedRange(
            {
                ...group,
                tableTarget: tableTargetsByFrom.get(group.from),
            },
            state,
            group.table.kind === 'gfm' ? 'table' : 'html-block',
            context
        ));
    }

    syntaxTree(state).iterate({
        enter(node) {
            if (renderedGroups.some(group => rangeContains(group, node))) {
                return false;
            }
            const result = decorateSyntaxNode(node, state, decorations, context);
            if (result === false) return false;
            const paragraph = node.name === 'Paragraph';
            if (paragraph || isHeadingNode(node.name)) {
                decorateMath(
                    node,
                    state,
                    decorations,
                    excludedMathRanges,
                    context,
                    paragraph
                );
            }
            return undefined;
        },
    });
    decorateCitations(state, decorations, context);
    decorateTableReferences(state, decorations, context);
    return Decoration.set(decorations, true);
}

function rangeContains(outer, inner) {
    return inner.from >= outer.from && inner.to <= outer.to;
}

function decorateCitations(state, decorations, context) {
    const result = citationAnalysis(state, context);
    const hiddenSuperscriptMarkup = new Set();
    for (const affiliation of result.affiliations) {
        const markup = affiliation.markerMarkup;
        if (!markup
            || editingRangeIntersects(
                context,
                markup.wrapperFrom,
                affiliation.to
            )
            || citationRangeIsExcluded(state, markup.contentFrom)) {
            continue;
        }
        hideSuperscriptMarkup(decorations, markup, hiddenSuperscriptMarkup);
        decorations.push(Decoration.mark({
            class: [
                'cm-mktero-affiliation-marker',
                markup.raiseContent
                    ? 'cm-mktero-citation-superscript'
                    : '',
            ].filter(Boolean).join(' '),
        }).range(markup.contentFrom, markup.contentTo));
    }
    for (const citation of result.citations) {
        const markup = citation.superscriptMarkup;
        const decoratedFrom = markup?.wrapperFrom ?? citation.from;
        const decoratedTo = markup?.wrapperTo ?? citation.to;
        if (editingRangeIntersects(context, decoratedFrom, decoratedTo)
            || citationRangeIsExcluded(state, citation.from)) {
            continue;
        }
        if (markup) {
            hideSuperscriptMarkup(
                decorations,
                markup,
                hiddenSuperscriptMarkup
            );
        }
        decorations.push(Decoration.mark({
            class: citationClassName(citation),
            attributes: citationAttributes(citation),
        }).range(citation.from, citation.to));
    }

    const highlighted = context.citationTargets.get(
        context.highlightedReferenceID
    );
    if (highlighted) {
        decorations.push(Decoration.mark({
            class: 'cm-mktero-reference-highlight',
        }).range(highlighted.from, highlighted.to));
    }
}

function hideSuperscriptMarkup(decorations, markup, hiddenMarkup) {
    const markupKey = `${markup.wrapperFrom}:${markup.wrapperTo}`;
    if (hiddenMarkup.has(markupKey)) return;
    hiddenMarkup.add(markupKey);
    if (markup.wrapperFrom < markup.contentFrom) {
        decorations.push(Decoration.replace({}).range(
            markup.wrapperFrom,
            markup.contentFrom
        ));
    }
    if (markup.contentTo < markup.wrapperTo) {
        decorations.push(Decoration.replace({}).range(
            markup.contentTo,
            markup.wrapperTo
        ));
    }
}

function citationAnalysis(state, context) {
    if (context.citationAnalysisDocument === state.doc) {
        return context.citationAnalysis;
    }
    const result = analyzeMarkdownCitations(state.doc.toString());
    context.citationAnalysisDocument = state.doc;
    context.citationAnalysis = result;
    context.citationTargets = new Map(
        [...result.references, ...result.affiliations]
            .map(target => [target.id, target])
    );
    return result;
}

function tableReferenceAnalysis(state, context) {
    if (context.tableReferenceAnalysisDocument === state.doc) {
        return context.tableReferenceAnalysis;
    }
    const result = analyzeMarkdownTableReferences(state.doc.toString());
    context.tableReferenceAnalysisDocument = state.doc;
    context.tableReferenceAnalysis = result;
    context.tableTargets = new Map(
        result.targets.map(target => [target.id, target])
    );
    return result;
}

function decorateTableReferences(state, decorations, context) {
    for (const reference of tableReferenceAnalysis(state, context).references) {
        if (editingRangeIntersects(context, reference.from, reference.to)
            || tableReferenceRangeIsExcluded(state, reference.from)) {
            continue;
        }
        const target = context.tableTargets.get(reference.targetId);
        if (!target) continue;
        decorations.push(Decoration.mark({
            class: 'cm-mktero-table-reference',
            attributes: {
                role: 'link',
                tabindex: '0',
                'aria-label': `预览并跳转到 ${target.label}`,
                'data-table-target-id': target.id,
            },
        }).range(reference.from, reference.to));
    }
}

function tableReferenceRangeIsExcluded(state, position) {
    let node = syntaxTree(state).resolveInner(position, 1);
    while (node) {
        if (['InlineCode', 'FencedCode', 'CodeBlock', 'Image', 'URL',
            'HTMLBlock', 'Link'].includes(node.name)) {
            return true;
        }
        node = node.parent;
    }
    return false;
}

function citationRangeIsExcluded(state, position) {
    let node = syntaxTree(state).resolveInner(position, 1);
    while (node) {
        if (['InlineCode', 'FencedCode', 'CodeBlock', 'Image', 'URL', 'HTMLBlock']
            .includes(node.name)) {
            return true;
        }
        if (node.name === 'Link') {
            const source = state.sliceDoc(node.from, node.to);
            return !isBracketedNumericCitation(source);
        }
        node = node.parent;
    }
    return false;
}

function citationLabel(targets, kind) {
    if (kind === 'affiliation') {
        if (targets.length === 1) {
            return `查看作者单位 ${targets[0].number}`;
        }
        return `查看 ${targets.length} 个作者单位`;
    }
    if (targets.length === 1) {
        const target = targets[0];
        return Number.isInteger(target.number)
            ? `查看引用 ${target.number}`
            : `查看引用：${target.text}`;
    }
    return `查看 ${targets.length} 条引用`;
}

function citationElement(event, view) {
    const citation = event.target?.closest?.('.cm-mktero-citation');
    return citation && view.dom.contains(citation) ? citation : null;
}

function tableReferenceElement(event, view) {
    const reference = event.target?.closest?.('.cm-mktero-table-reference');
    return reference && view.dom.contains(reference) ? reference : null;
}

function tableTargetForReference(reference, context) {
    return context.tableTargets.get(
        reference.getAttribute('data-table-target-id') || ''
    );
}

function openTablePreviewPopup(reference, context) {
    const target = tableTargetForReference(reference, context);
    if (!target) return;
    context.tablePreviewPopup?.open({ anchor: reference, target });
}

function targetsForCitation(citation, context) {
    return (citation.getAttribute('data-citation-ids') || '')
        .split(/\s+/)
        .map(id => context.citationTargets.get(id))
        .filter(Boolean);
}

function openCitationPopup(citation, view, context, focusFirst = false) {
    const kind = citation.getAttribute('data-citation-kind');
    context.citationPopup?.open({
        anchor: citation,
        targets: targetsForCitation(citation, context),
        label: kind === 'affiliation' ? '作者单位' : '引用详情',
        focusFirst,
        onActivate(target) {
            context.activateCitation?.(view, target);
        },
    });
}

function activateCitationElement(citation, view, context) {
    const target = targetsForCitation(citation, context)[0];
    if (!target) return false;
    context.citationPopup?.close();
    context.activateCitation?.(view, target);
    return true;
}

function activateTableReferenceElement(reference, view, context) {
    const target = tableTargetForReference(reference, context);
    if (!target) return false;
    context.tablePreviewPopup?.close();
    context.activateTableReference?.(view, target);
    return true;
}

function decorateSyntaxNode(node, state, decorations, context) {
    if (isHeadingNode(node.name)) {
        const level = Number(node.name.at(-1));
        decorations.push(Decoration.line({
            class: `cm-mktero-heading cm-mktero-heading-${level}`,
        }).range(node.from));
        return;
    }

    const inlineClasses = {
        StrongEmphasis: 'cm-mktero-strong',
        Emphasis: 'cm-mktero-emphasis',
        Strikethrough: 'cm-mktero-strikethrough',
        InlineCode: 'cm-mktero-code',
    };
    if (inlineClasses[node.name]) {
        decorations.push(Decoration.mark({
            class: inlineClasses[node.name],
        }).range(node.from, node.to));
        return;
    }

    if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark'].includes(node.name)) {
        const parent = node.node.parent;
        if (parent && !editingRangeIntersects(context, parent.from, parent.to)) {
            let to = node.to;
            if (node.name === 'HeaderMark' && state.sliceDoc(to, to + 1) === ' ') to++;
            decorations.push(Decoration.replace({}).range(node.from, to));
        }
        return;
    }

    if (node.name === 'Escape'
        && !editingRangeIntersects(context, node.from, node.to)
        && state.sliceDoc(node.from, node.from + 1) === '\\') {
        decorations.push(Decoration.replace({}).range(node.from, node.from + 1));
        return;
    }

    if (node.name === 'Link' && !editingRangeIntersects(context, node.from, node.to)) {
        const source = state.sliceDoc(node.from, node.to);
        if (!isBracketedNumericCitation(source)) {
            decorateLink(node, state, decorations);
        }
        return;
    }

    if (node.name === 'Autolink'
        && !editingRangeIntersects(context, node.from, node.to)) {
        const url = node.node.getChild('URL');
        if (url) {
            decorations.push(Decoration.mark({
                class: 'cm-mktero-link',
            }).range(url.from, url.to));
            if (node.from < url.from) {
                decorations.push(Decoration.replace({}).range(node.from, url.from));
            }
            if (url.to < node.to) {
                decorations.push(Decoration.replace({}).range(url.to, node.to));
            }
        }
        return false;
    }

    if (node.name === 'URL') {
        const parentName = node.node.parent?.name;
        if (!['Link', 'Autolink', 'LinkReference'].includes(parentName)
            && !editingRangeIntersects(context, node.from, node.to)) {
            decorations.push(Decoration.mark({
                class: 'cm-mktero-link',
            }).range(node.from, node.to));
        }
        return;
    }

    if (node.name === 'LinkReference') {
        if (!editingRangeIntersects(context, node.from, node.to)) {
            decorations.push(Decoration.replace({}).range(node.from, node.to));
            return false;
        }
        return;
    }

    if (node.name === 'QuoteMark') {
        const parent = node.node.parent;
        const line = state.doc.lineAt(node.from);
        decorations.push(Decoration.line({
            class: 'cm-mktero-blockquote',
        }).range(line.from));
        if (parent && !editingRangeIntersects(context, parent.from, parent.to)) {
            let to = node.to;
            if (state.sliceDoc(to, to + 1) === ' ') to++;
            decorations.push(Decoration.replace({}).range(node.from, to));
        }
        return;
    }

    if (node.name === 'ListMark') {
        const item = node.node.parent;
        if (item && !editingRangeIntersects(context, item.from, item.to)) {
            const listType = item.parent?.name;
            const ordered = listType === 'OrderedList';
            decorations.push(Decoration.replace({
                widget: new TextMarkerWidget(
                    ordered ? state.sliceDoc(node.from, node.to) : '•',
                    ordered ? 'cm-mktero-list-number' : 'cm-mktero-list-bullet'
                ),
            }).range(node.from, node.to));
        }
        return;
    }

    if (node.name === 'TaskMarker') {
        const task = node.node.parent;
        if (task && !editingRangeIntersects(context, task.from, task.to)) {
            decorations.push(Decoration.replace({
                widget: new TaskCheckboxWidget({
                    checked: /x/i.test(state.sliceDoc(node.from, node.to)),
                    from: node.from,
                    to: node.to,
                }),
            }).range(node.from, node.to));
        }
        return;
    }

    if (node.name === 'HorizontalRule'
        && !editingRangeIntersects(context, node.from, node.to)) {
        decorations.push(renderedRange(node, state, 'divider', context));
        return false;
    }

    if (node.name === 'Table' && !editingRangeIntersects(context, node.from, node.to)) {
        decorations.push(renderedRange(node, state, 'table', context));
        return false;
    }
    if (['FencedCode', 'CodeBlock'].includes(node.name)) {
        const range = node.name === 'CodeBlock'
            ? { from: state.doc.lineAt(node.from).from, to: node.to }
            : node;
        if (!editingRangeIntersects(context, range.from, range.to)) {
            decorations.push(renderedRange(range, state, 'code-block', context));
            return false;
        }
        return;
    }
    if (['HTMLBlock', 'CommentBlock'].includes(node.name)
        && shouldRenderHTMLBlock(state.sliceDoc(node.from, node.to))
        && !editingRangeIntersects(context, node.from, node.to)) {
        decorations.push(renderedRange(node, state, 'html-block', context));
        return false;
    }
    if (node.name === 'Image') {
        const parent = node.node.parent;
        const blockRange = parent?.name === 'Paragraph'
            ? standaloneImageLineRange(node, state)
            : null;
        if (blockRange
            && !editingRangeIntersects(context, blockRange.from, blockRange.to)) {
            decorations.push(renderedRange(blockRange, state, 'image', context));
            return false;
        }
        if (!editingRangeIntersects(context, node.from, node.to)) {
            decorations.push(Decoration.replace({
                widget: new RenderedMarkdownWidget({
                    source: state.sliceDoc(node.from, node.to),
                    display: 'image-inline',
                    from: node.from,
                    ...context,
                }),
            }).range(node.from, node.to));
            return false;
        }
    }
    return undefined;
}

function standaloneImageLineRange(node, state) {
    const line = state.doc.lineAt(node.from);
    if (node.to > line.to) return null;
    if (state.sliceDoc(line.from, node.from).trim()) return null;
    if (state.sliceDoc(node.to, line.to).trim()) return null;
    return { from: line.from, to: line.to };
}

function decorateLink(node, state, decorations) {
    const marks = node.node.getChildren('LinkMark');
    const closingLabel = marks.find(mark => state.sliceDoc(mark.from, mark.to) === ']');
    if (!marks.length || !closingLabel) return;
    const labelFrom = marks[0].to;
    const labelTo = closingLabel.from;
    if (labelFrom < labelTo) {
        decorations.push(Decoration.mark({
            class: 'cm-mktero-link',
        }).range(labelFrom, labelTo));
        decorations.push(Decoration.replace({}).range(node.from, labelFrom));
        decorations.push(Decoration.replace({}).range(labelTo, node.to));
    }
}

function decorateMath(
    node,
    state,
    decorations,
    excludedRanges,
    context,
    renderDisplayMath
) {
    const source = state.sliceDoc(node.from, node.to);
    const displayMatches = findDisplayMathMatches(source);
    const displayRanges = displayMatches.map(match => ({
        from: node.from + match.start,
        to: node.from + match.end,
    }));
    if (renderDisplayMath) {
        for (const match of displayMatches) {
            const matchFrom = node.from + match.start;
            const matchTo = node.from + match.end;
            if (editingRangeIntersects(context, matchFrom, matchTo)) continue;
            decorations.push(renderedMathRange(
                match.raw,
                matchFrom,
                matchTo,
                'math-display',
                context
            ));
        }
    }

    for (const match of findInlineMathMatches(source)) {
        const matchFrom = node.from + match.start;
        const matchTo = node.from + match.end;
        if (rangeOverlapsAny(matchFrom, matchTo, displayRanges)
            || rangeOverlapsAny(matchFrom, matchTo, excludedRanges)
            || editingRangeIntersects(context, matchFrom, matchTo)) continue;
        if (hasSuperscriptCitationMarkup(
            state,
            context,
            matchFrom,
            matchTo
        )) {
            continue;
        }
        const citationContent = dollarWrappedNumericCitationContent(match.raw);
        if (citationContent) {
            const contentFrom = matchFrom + citationContent.from;
            const contentTo = matchFrom + citationContent.to;
            if (matchFrom < contentFrom) {
                decorations.push(Decoration.replace({}).range(matchFrom, contentFrom));
            }
            if (contentTo < matchTo) {
                decorations.push(Decoration.replace({}).range(contentTo, matchTo));
            }
            continue;
        }
        decorations.push(renderedMathRange(
            match.raw,
            matchFrom,
            matchTo,
            'math',
            context,
            true,
            findAncestorAt(state, matchFrom, 'Link') ? 'cm-mktero-link' : ''
        ));
    }
}

function hasSuperscriptCitationMarkup(state, context, from, to) {
    const result = citationAnalysis(state, context);
    return result.citations.some(citation => (
        citation.superscriptMarkup?.wrapperFrom === from
            && citation.superscriptMarkup.wrapperTo === to
    )) || result.affiliations.some(affiliation => (
        affiliation.markerMarkup?.wrapperFrom === from
            && affiliation.markerMarkup.wrapperTo === to
    ));
}

function isBracketedNumericCitation(source) {
    return /^\[\s*\d+(?:\s*(?:[,;，；]\s*\d+|[-–—]\s*\d+))*\s*\]$/.test(
        source
    );
}

function dollarWrappedNumericCitationContent(source) {
    if (!source.startsWith('$') || !source.endsWith('$')) return null;
    const content = source.slice(1, -1);
    const trimmed = content.trim();
    if (!isBracketedNumericCitation(trimmed)) return null;
    const from = 1 + content.indexOf(trimmed);
    return { from, to: from + trimmed.length };
}

function renderedRange(node, state, display, context) {
    const source = node.table?.source || state.sliceDoc(node.from, node.to);
    const tableIsHighlighted = node.tableTarget?.id
        && node.tableTarget.id === context.highlightedTableID;
    if (display === 'table') {
        return Decoration.replace({
            widget: new EditableTableWidget({
                source,
                from: node.table?.from ?? node.from,
                to: node.table?.to ?? node.to,
                caption: node.caption,
                highlighted: tableIsHighlighted,
                ...context,
            }),
            block: true,
        }).range(node.from, node.to);
    }
    return Decoration.replace({
        widget: new RenderedMarkdownWidget({
            source: state.sliceDoc(node.from, node.to),
            display,
            from: node.from,
            citations: display === 'image'
                ? renderedCitationDescriptors(
                    state,
                    context,
                    node.from,
                    node.to
                )
                : [],
            extraClassName: [
                display === 'html-block'
                    && (node.table?.kind === 'html'
                        || /^\s*<table\b/i.test(source))
                    ? 'cm-mktero-html-table'
                    : '',
                tableIsHighlighted
                    ? 'cm-mktero-table-target-highlight'
                    : '',
            ].filter(Boolean).join(' '),
            ...context,
        }),
        block: true,
    }).range(node.from, node.to);
}

function renderedCitationDescriptors(state, context, from, to) {
    return citationAnalysis(state, context).citations
        .filter(citation => citation.from >= from && citation.to <= to)
        .map(citation => renderedCitationDescriptor(
            state,
            citation,
            from,
            to
        ));
}

function renderedCitationDescriptor(state, citation, rangeFrom, rangeTo) {
    const markerRange = visibleCitationMarkerRange(
        state,
        citation,
        rangeFrom,
        rangeTo
    );
    const markerSource = state.sliceDoc(markerRange.from, markerRange.to);
    const targetPrefix = state.sliceDoc(markerRange.from, citation.from);
    const target = visibleMarkdownText(
        state.sliceDoc(citation.from, citation.to)
    );
    return {
        key: `${citation.from}:${citation.to}:${citation.referenceIds.join(',')}`,
        markerFrom: markerRange.from,
        marker: visibleMarkdownText(markerSource),
        targetOffset: visibleMarkdownText(targetPrefix).length,
        targetLength: target.length,
        className: citationClassName(citation),
        attributes: citationAttributes(citation),
    };
}

function visibleCitationMarkerRange(state, citation, rangeFrom, rangeTo) {
    const markup = citation.superscriptMarkup;
    if (markup
        && markup.wrapperFrom >= rangeFrom
        && markup.wrapperTo <= rangeTo) {
        return { from: markup.wrapperFrom, to: markup.wrapperTo };
    }

    const prefixFrom = Math.max(rangeFrom, citation.from - 80);
    const prefix = state.sliceDoc(prefixFrom, citation.from);
    const openingOffset = prefix.lastIndexOf('[');
    const suffixTo = Math.min(rangeTo, citation.to + 80);
    const suffix = state.sliceDoc(citation.to, suffixTo);
    const closingOffset = suffix.indexOf(']');
    if (openingOffset >= 0
        && closingOffset >= 0
        && !/[\]\r\n]/.test(prefix.slice(openingOffset + 1))
        && !/[\[\r\n]/.test(suffix.slice(0, closingOffset))) {
        return {
            from: prefixFrom + openingOffset,
            to: citation.to + closingOffset + 1,
        };
    }
    return { from: citation.from, to: citation.to };
}

function visibleMarkdownText(value) {
    return String(value).replace(
        /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g,
        '$1'
    );
}

function citationClassName(citation) {
    return [
        'cm-mktero-citation',
        citation.superscriptMarkup?.raiseContent
            ? 'cm-mktero-citation-superscript'
            : '',
    ].filter(Boolean).join(' ');
}

function citationAttributes(citation) {
    return {
        role: 'link',
        tabindex: '0',
        'aria-label': citationLabel(citation.references, citation.kind),
        'data-citation-ids': citation.referenceIds.join(' '),
        'data-citation-kind': citation.kind,
    };
}

function renderedMathRange(
    source,
    from,
    to,
    display,
    context,
    inline = false,
    extraClassName = ''
) {
    return Decoration.replace({
        widget: new RenderedMarkdownWidget({
            source,
            display,
            from,
            extraClassName,
            ...context,
        }),
        block: !inline,
    }).range(from, to);
}

function collectExcludedMathRanges(state) {
    const ranges = [];
    syntaxTree(state).iterate({
        enter(node) {
            if (['InlineCode', 'FencedCode', 'CodeBlock', 'Image', 'URL']
                .includes(node.name)) {
                ranges.push({ from: node.from, to: node.to });
            }
        },
    });
    return ranges;
}

function isHeadingNode(name) {
    return /^(?:ATXHeading[1-6]|SetextHeading[12])$/.test(name);
}

function findAncestorAt(state, position, name) {
    let node = syntaxTree(state).resolveInner(position, 1);
    while (node && node.name !== name) node = node.parent;
    return node;
}

function editingRangeIntersects(context, from, to) {
    const range = context.editingRange;
    return Boolean(range && range.from < to && range.to > from);
}

function rangeOverlapsAny(from, to, ranges) {
    return ranges.some(range => range.from < to && range.to > from);
}

function shouldRenderHTMLBlock(source) {
    return /^\s*(?:<!--\s*zotero-page:|<table\b)/i.test(source);
}
