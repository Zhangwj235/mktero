import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import {
    clearInlineEditing,
    createInlineRenderingExtension,
    refreshInlineRendering,
    setReferenceHighlight,
} from './inline-rendering.js';
import { runEditorCommand, runSaveShortcut } from './editor-commands.js';
import { createImagePreview } from './image-preview.js';
import { createCitationPopup } from './citation-popup.js';

const externalUpdate = Annotation.define();
const editorNavigationMeasureKey = {};
const DOM_GLOBAL_NAMES = [
    'document',
    'window',
    'Window',
    'IntersectionObserver',
    'MutationObserver',
    'ResizeObserver',
];
const DOM_ACTIVATION_EVENTS = [
    'beforeinput',
    'click',
    'compositionend',
    'compositionstart',
    'compositionupdate',
    'copy',
    'cut',
    'dragstart',
    'drop',
    'focusin',
    'input',
    'keydown',
    'keyup',
    'mousedown',
    'paste',
    'pointerdown',
    'scroll',
    'wheel',
];
let activeDOMWindow = null;
const domWindowReferences = new Map();
let previousDOMGlobals = null;

function requestEditorScroll(view, position, requestedDocument, correctAfterRender = true) {
    view.requestMeasure({
        key: editorNavigationMeasureKey,
        read(editorView) {
            if (editorView.state.doc !== requestedDocument) return null;
            return {
                top: editorView.lineBlockAt(position).top,
                targetIsRendered: position >= editorView.viewport.from
                    && position <= editorView.viewport.to,
            };
        },
        write(measurement, editorView) {
            if (!measurement || editorView.state.doc !== requestedDocument) return;
            editorView.scrollDOM.scrollTop = Math.max(0, measurement.top);
            if (correctAfterRender && !measurement.targetIsRendered) {
                // Offscreen block-widget heights are estimates until this scroll renders them.
                requestEditorScroll(editorView, position, requestedDocument, false);
            }
        },
    });
}

export function createInlineMarkdownEditor({
    parent,
    initialMarkdown,
    resolveImageURL,
    openLink,
    onChange,
    onSaveRequest,
}) {
    if (!parent) throw new Error('An editor parent element is required');
    const ownerWindow = parent.ownerDocument?.defaultView;
    if (!ownerWindow) throw new Error('The editor requires a browser window');
    acquireDOMGlobals(ownerWindow);
    const imagePreview = createImagePreview(parent);
    const citationPopup = createCitationPopup(parent);
    const editingMode = new Compartment();
    let editingEnabled = false;
    let citationHighlightTimer = null;
    let destroyed = false;
    const setEditingEnabled = (editorView, enabled) => {
        if (editingEnabled === enabled) return;
        editingEnabled = enabled;
        editorView.dispatch({
            effects: editingMode.reconfigure([
                EditorView.editable.of(enabled),
                EditorState.readOnly.of(!enabled),
            ]),
        });
    };
    let view;
    const removeDOMActivation = installDOMActivation(
        parent,
        ownerWindow,
        event => {
            if (!view) return;
            if (citationPopup.contains(event.target)) return;
            if (event.type === 'scroll' || event.type === 'wheel') {
                citationPopup.close();
            }
            view.requestMeasure();
            if (event.type === 'scroll'
                && typeof ownerWindow.IntersectionObserver !== 'function') {
                view.measure();
            }
        }
    );

    try {
        const state = EditorState.create({
            doc: initialMarkdown || '',
            extensions: [
                markdown({ extensions: [GFM] }),
                createInlineRenderingExtension({
                    resolveImageURL,
                    openLink,
                    onSaveRequest,
                    openImagePreview: imagePreview.open,
                    citationPopup,
                    activateCitation(editorView, target) {
                        if (citationHighlightTimer !== null) {
                            ownerWindow.clearTimeout(citationHighlightTimer);
                        }
                        editorView.dispatch({
                            effects: setReferenceHighlight.of(target.id),
                        });
                        requestEditorScroll(
                            editorView,
                            target.from,
                            editorView.state.doc
                        );
                        citationHighlightTimer = ownerWindow.setTimeout(() => {
                            citationHighlightTimer = null;
                            if (destroyed) return;
                            editorView.dispatch({
                                effects: setReferenceHighlight.of(null),
                            });
                        }, 3000);
                    },
                    enterEditing: editorView => setEditingEnabled(editorView, true),
                    exitEditing: editorView => setEditingEnabled(editorView, false),
                }),
                editingMode.of([
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                ]),
                history(),
                keymap.of([
                    ...defaultKeymap,
                    ...historyKeymap,
                    ...searchKeymap,
                ]),
                EditorView.domEventHandlers({
                    keydown(event, editorView) {
                        return runSaveShortcut(
                            event,
                            () => editorView.state.doc.toString(),
                            onSaveRequest
                        );
                    },
                }),
                EditorView.lineWrapping,
                EditorView.updateListener.of(update => {
                    if (!update.docChanged) return;
                    const isExternal = update.transactions.some(transaction => (
                        transaction.annotation(externalUpdate)
                    ));
                    if (!isExternal) onChange?.(update.state.doc.toString());
                }),
            ],
        });
        const root = parent.getRootNode?.();
        view = new EditorView({
            state,
            parent,
            root: root?.nodeType === 9 || root?.nodeType === 11 ? root : undefined,
        });
    }
    catch (error) {
        citationPopup.destroy();
        imagePreview.destroy();
        removeDOMActivation();
        releaseDOMGlobals(ownerWindow);
        throw error;
    }
    return {
        getMarkdown() {
            return view.state.doc.toString();
        },
        setMarkdown(markdown) {
            activateDOMGlobals(ownerWindow);
            citationPopup.close();
            if (citationHighlightTimer !== null) {
                ownerWindow.clearTimeout(citationHighlightTimer);
                citationHighlightTimer = null;
            }
            const value = String(markdown || '');
            if (value === view.state.doc.toString()) {
                view.dispatch({ effects: setReferenceHighlight.of(null) });
                return;
            }
            setEditingEnabled(view, false);
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: value },
                effects: [
                    clearInlineEditing.of(null),
                    setReferenceHighlight.of(null),
                ],
                annotations: [
                    externalUpdate.of(true),
                    Transaction.addToHistory.of(false),
                ],
            });
        },
        focus() {
            activateDOMGlobals(ownerWindow);
            view.focus();
        },
        scrollToOffset(offset) {
            activateDOMGlobals(ownerWindow);
            const requested = Number(offset);
            const position = Number.isFinite(requested)
                ? Math.max(0, Math.min(Math.trunc(requested), view.state.doc.length))
                : 0;
            const requestedDocument = view.state.doc;
            requestEditorScroll(view, position, requestedDocument);
        },
        refreshRendering() {
            activateDOMGlobals(ownerWindow);
            view.dispatch({ effects: refreshInlineRendering.of(null) });
        },
        runCommand(command) {
            activateDOMGlobals(ownerWindow);
            const enteredForCommand = !editingEnabled;
            if (enteredForCommand) setEditingEnabled(view, true);
            try {
                return runEditorCommand(view, command);
            }
            finally {
                if (enteredForCommand) setEditingEnabled(view, false);
            }
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            activateDOMGlobals(ownerWindow);
            try {
                if (citationHighlightTimer !== null) {
                    ownerWindow.clearTimeout(citationHighlightTimer);
                    citationHighlightTimer = null;
                }
                citationPopup.destroy();
                imagePreview.destroy();
                view.destroy();
            }
            finally {
                removeDOMActivation();
                releaseDOMGlobals(ownerWindow);
            }
        },
    };
}

function acquireDOMGlobals(ownerWindow) {
    if (!domWindowReferences.size) {
        previousDOMGlobals = new Map();
        for (const name of DOM_GLOBAL_NAMES) {
            previousDOMGlobals.set(name, {
                exists: Object.hasOwn(globalThis, name),
                value: globalThis[name],
            });
        }
    }
    domWindowReferences.set(
        ownerWindow,
        (domWindowReferences.get(ownerWindow) || 0) + 1
    );
    activateDOMGlobals(ownerWindow);
}

function activateDOMGlobals(ownerWindow) {
    if (activeDOMWindow === ownerWindow) return;
    for (const name of DOM_GLOBAL_NAMES) {
        globalThis[name] = name === 'document'
            ? ownerWindow.document
            : ownerWindow[name];
    }
    activeDOMWindow = ownerWindow;
}

function installDOMActivation(parent, ownerWindow, refreshViewport) {
    const activate = event => {
        activateDOMGlobals(ownerWindow);
        if (event?.type === 'scroll' || event?.type === 'wheel') {
            refreshViewport?.(event);
        }
    };
    for (const type of DOM_ACTIVATION_EVENTS) {
        parent.addEventListener(type, activate, true);
    }
    const onSelectionChange = () => {
        const anchor = ownerWindow.document.getSelection?.().anchorNode;
        if (anchor && parent.contains(anchor)) activate();
    };
    ownerWindow.document.addEventListener('selectionchange', onSelectionChange);

    return () => {
        for (const type of DOM_ACTIVATION_EVENTS) {
            parent.removeEventListener(type, activate, true);
        }
        ownerWindow.document.removeEventListener('selectionchange', onSelectionChange);
    };
}

function releaseDOMGlobals(ownerWindow) {
    const references = domWindowReferences.get(ownerWindow) || 0;
    if (!references) return;
    if (references === 1) domWindowReferences.delete(ownerWindow);
    else domWindowReferences.set(ownerWindow, references - 1);

    if (domWindowReferences.size) {
        if (!domWindowReferences.has(activeDOMWindow)) {
            activateDOMGlobals(domWindowReferences.keys().next().value);
        }
        return;
    }

    for (const [name, previous] of previousDOMGlobals) {
        if (previous.exists) globalThis[name] = previous.value;
        else delete globalThis[name];
    }
    previousDOMGlobals = null;
    activeDOMWindow = null;
}
