import { syntaxTree } from '@codemirror/language';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
    safeMarkdownLinkURL,
} from '../markdown/markdown-html.js';
import { EditableTableWidget } from './editable-table-widget.js';
import {
    appendRenderedMarkdown,
    openRenderedLink,
} from './rendered-markdown-dom.js';

class RenderedMarkdownWidget extends WidgetType {
    constructor({
        source,
        display,
        from,
        resolveImageURL,
        openLink,
        renderVersion,
        extraClassName = '',
    }) {
        super();
        this.source = source;
        this.display = display;
        this.from = from;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
        this.renderVersion = renderVersion;
        this.extraClassName = extraClassName;
    }

    eq(other) {
        return this.source === other.source
            && this.display === other.display
            && this.from === other.from
            && this.renderVersion === other.renderVersion
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

        container.addEventListener('mousedown', event => {
            openRenderedLink(event, this.openLink);
        });
        container.addEventListener('click', event => {
            if (event.target?.closest?.('a[href]')) return;
            if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
            const selection = document.defaultView.getSelection?.();
            if (selection && !selection.isCollapsed) return;
            event.preventDefault();
            view.dispatch({ selection: { anchor: this.from } });
            view.focus();
        });
        return container;
    }

    ignoreEvent() {
        return true;
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
}) {
    const context = {
        resolveImageURL,
        openLink,
        onSaveRequest,
        renderVersion: 0,
    };
    const renderingField = StateField.define({
        create(state) {
            return buildDecorations(state, context);
        },
        update(decorations, transaction) {
            const shouldRefresh = transaction.effects.some(effect => (
                effect.is(refreshInlineRendering)
            ));
            if (shouldRefresh) context.renderVersion++;
            if (transaction.docChanged
                || transaction.selection
                || shouldRefresh) {
                return buildDecorations(transaction.state, context);
            }
            return decorations;
        },
        provide: field => EditorView.decorations.from(field),
    });
    return [
        renderingField,
        EditorView.domEventHandlers({
            mousedown(event, view) {
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
        }),
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

function buildDecorations(state, context) {
    const decorations = [];
    const excludedMathRanges = collectExcludedMathRanges(state);

    syntaxTree(state).iterate({
        enter(node) {
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
    return Decoration.set(decorations, true);
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
        if (parent && !selectionIntersects(state, parent.from, parent.to)) {
            let to = node.to;
            if (node.name === 'HeaderMark' && state.sliceDoc(to, to + 1) === ' ') to++;
            decorations.push(Decoration.replace({}).range(node.from, to));
        }
        return;
    }

    if (node.name === 'Link' && !selectionIntersects(state, node.from, node.to)) {
        decorateLink(node, state, decorations);
        return;
    }

    if (node.name === 'Autolink'
        && !selectionIntersects(state, node.from, node.to)) {
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
            && !selectionIntersects(state, node.from, node.to)) {
            decorations.push(Decoration.mark({
                class: 'cm-mktero-link',
            }).range(node.from, node.to));
        }
        return;
    }

    if (node.name === 'LinkReference') {
        if (!selectionIntersects(state, node.from, node.to)) {
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
        if (parent && !selectionIntersects(state, parent.from, parent.to)) {
            let to = node.to;
            if (state.sliceDoc(to, to + 1) === ' ') to++;
            decorations.push(Decoration.replace({}).range(node.from, to));
        }
        return;
    }

    if (node.name === 'ListMark') {
        const item = node.node.parent;
        if (item && !selectionIntersects(state, item.from, item.to)) {
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
        if (task && !selectionIntersects(state, task.from, task.to)) {
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
        && !selectionIntersects(state, node.from, node.to)) {
        decorations.push(renderedRange(node, state, 'divider', context));
        return false;
    }

    if (node.name === 'Table' && !selectionIntersects(state, node.from, node.to)) {
        decorations.push(renderedRange(node, state, 'table', context));
        return false;
    }
    if (['FencedCode', 'CodeBlock'].includes(node.name)) {
        const range = node.name === 'CodeBlock'
            ? { from: state.doc.lineAt(node.from).from, to: node.to }
            : node;
        if (!selectionIntersects(state, range.from, range.to)) {
            decorations.push(renderedRange(range, state, 'code-block', context));
            return false;
        }
        return;
    }
    if (['HTMLBlock', 'CommentBlock'].includes(node.name)
        && shouldRenderHTMLBlock(state.sliceDoc(node.from, node.to))
        && !selectionIntersects(state, node.from, node.to)) {
        decorations.push(renderedRange(node, state, 'html-block', context));
        return false;
    }
    if (node.name === 'Image') {
        const parent = node.node.parent;
        if (parent?.name === 'Paragraph'
            && state.sliceDoc(parent.from, parent.to).trim() === state.sliceDoc(node.from, node.to)
            && !selectionIntersects(state, parent.from, parent.to)) {
            decorations.push(renderedRange(parent, state, 'image', context));
            return false;
        }
        if (!selectionIntersects(state, node.from, node.to)) {
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
            if (selectionIntersects(state, matchFrom, matchTo)) continue;
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
            || selectionIntersects(state, matchFrom, matchTo)) continue;
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

function renderedRange(node, state, display, context) {
    if (display === 'table') {
        return Decoration.replace({
            widget: new EditableTableWidget({
                source: state.sliceDoc(node.from, node.to),
                from: node.from,
                to: node.to,
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
            ...context,
        }),
        block: true,
    }).range(node.from, node.to);
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

function selectionIntersects(state, from, to) {
    return state.selection.ranges.some(range => (
        range.empty
            ? range.head >= from && range.head <= to
            : range.from < to && range.to > from
    ));
}

function rangeOverlapsAny(from, to, ranges) {
    return ranges.some(range => range.from < to && range.to > from);
}

function shouldRenderHTMLBlock(source) {
    return /^\s*(?:<!--\s*zotero-page:|<table\b)/i.test(source);
}
