import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import {
    findUniqueContainingSourceMapEntry,
    resolveSourceMapLocation,
} from '../core/markdown-source-map.js';
import { createLocalization } from '../i18n/localization.js';
import { createEvidenceSnippet } from '../markdown/markdown-evidence.js';
import {
    createInlineRenderingExtension,
    pointerTouchesRect,
    refreshInlineRendering,
    selectedMarkdownAnnotation,
    selectionAnchor,
    setAnnotationOverlay,
    setCorrectionRenderingState,
    setFigureHighlight,
    setInlineEditingRange,
    setReferenceHighlight,
    setTableHighlight,
} from './inline-rendering.js';
import { createImagePreview } from './image-preview.js';
import { createCitationPopup } from './citation-popup.js';
import { createAnnotationPopup } from './annotation-popup.js';
import { createFigurePreviewPopup } from './figure-preview-popup.js';
import { createTablePreviewPopup } from './table-preview-popup.js';

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
    createMarkdownAnnotation,
    changeAnnotationColor,
    updateAnnotationComment,
    deleteAnnotation,
    copySourcedMarkdown,
    copyCode,
    openSourceLocation,
    openAnnotationInPDF,
    onSourceNavigationError,
    onViewportChange,
    onCommitCorrection,
    onRestoreCorrection,
    onCorrectionError,
    localization = createLocalization(),
}) {
    const t = localization.t.bind(localization);
    if (!parent) throw new Error(t('error.editorParentRequired'));
    const ownerWindow = parent.ownerDocument?.defaultView;
    if (!ownerWindow) throw new Error(t('error.editorWindowRequired'));
    acquireDOMGlobals(ownerWindow);
    const imagePreview = createImagePreview(parent, { localization });
    const citationPopup = createCitationPopup(parent, { localization });
    const annotationPopup = createAnnotationPopup(parent, {
        localization,
        createMarkdownAnnotation: typeof createMarkdownAnnotation === 'function'
            ? async annotation => {
                const saved = await createMarkdownAnnotation(annotation);
                ownerWindow.getSelection?.()?.removeAllRanges?.();
                return saved;
            }
            : undefined,
        changeAnnotationColor,
        updateAnnotationComment,
        deleteAnnotation,
        copySourcedMarkdown,
        openSourceLocation,
        openAnnotationInPDF,
        onSourceNavigationError,
    });
    const tablePreviewPopup = createTablePreviewPopup(parent, {
        resolveImageURL,
        localization,
    });
    const figurePreviewPopup = createFigurePreviewPopup(parent, {
        resolveImageURL,
        localization,
    });
    let destroyed = false;
    const citationHighlight = createTimedTargetHighlight({
        ownerWindow,
        effect: setReferenceHighlight,
        isDestroyed: () => destroyed,
    });
    const tableHighlight = createTimedTargetHighlight({
        ownerWindow,
        effect: setTableHighlight,
        isDestroyed: () => destroyed,
    });
    const figureHighlight = createTimedTargetHighlight({
        ownerWindow,
        effect: setFigureHighlight,
        isDestroyed: () => destroyed,
    });
    const referenceFeatures = {
        citation: {
            popup: citationPopup,
            highlight: citationHighlight,
            effect: setReferenceHighlight,
        },
        table: {
            popup: tablePreviewPopup,
            highlight: tableHighlight,
            effect: setTableHighlight,
        },
        figure: {
            popup: figurePreviewPopup,
            highlight: figureHighlight,
            effect: setFigureHighlight,
        },
    };
    const referenceFeatureList = Object.values(referenceFeatures);
    const interactionPopups = [
        annotationPopup,
        ...referenceFeatureList.map(feature => feature.popup),
    ];
    const editingMode = new Compartment();
    let correctionEnabled = false;
    let correctionBlocks = [];
    let correctedBlockIDs = [];
    let activeCorrection = null;
    let correctionBusy = false;
    let tableCorrectionEditing = false;
    let view;
    const removeDOMActivation = installDOMActivation(
        parent,
        ownerWindow,
        event => {
            if (!view) return;
            if (interactionPopups.some(popup => popup.contains(event.target))) {
                return;
            }
            if (event.type === 'scroll' || event.type === 'wheel') {
                for (const popup of interactionPopups) popup.close();
            }
            const isEditorScroll = event.type === 'scroll'
                && event.target === view.scrollDOM;
            const viewportRepaired = isEditorScroll
                && repairStalledViewport(view);
            view.requestMeasure();
            if (isEditorScroll) {
                onViewportChange?.(editorViewportOffset(view));
            }
            if (isEditorScroll
                && !viewportRepaired
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
                    openImagePreview: imagePreview.open,
                    copyCode,
                    citationPopup,
                    tablePreviewPopup,
                    figurePreviewPopup,
                    annotationPopup,
                    activateCitation:
                        referenceFeatures.citation.highlight.activate,
                    activateTableReference:
                        referenceFeatures.table.highlight.activate,
                    activateFigureReference:
                        referenceFeatures.figure.highlight.activate,
                    commitCorrection: correction => (
                        onCommitCorrection?.(correction)
                    ),
                    restoreCorrection: blockID => (
                        onRestoreCorrection?.(blockID)
                    ),
                    onCorrectionError,
                    onCorrectionEditingChange(editing) {
                        tableCorrectionEditing = Boolean(editing);
                        if (tableCorrectionEditing) annotationPopup.close();
                    },
                    translate: t,
                }),
                editingMode.of([
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                ]),
                EditorState.transactionFilter.of(transaction => {
                    if (!transaction.docChanged || !activeCorrection) {
                        return transaction;
                    }
                    let allowed = true;
                    transaction.changes.iterChangedRanges((from, to) => {
                        if (from < activeCorrection.from
                            || to > activeCorrection.to) {
                            allowed = false;
                        }
                    });
                    return allowed ? transaction : [];
                }),
                history(),
                Prec.highest(EditorView.domEventHandlers({
                    keydown(event) {
                        if (!activeCorrection) return false;
                        if (event.isComposing || view.composing) {
                            if (event.key === 'Enter'
                                && (event.metaKey || event.ctrlKey)) {
                                event.stopPropagation();
                            }
                            return false;
                        }
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            cancelActiveCorrection();
                            return true;
                        }
                        if (event.key === 'Enter'
                            && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            event.stopPropagation();
                            void commitActiveCorrection();
                            return true;
                        }
                        return false;
                    },
                })),
                keymap.of([
                    ...defaultKeymap,
                    ...historyKeymap,
                    ...searchKeymap,
                ]),
                EditorView.lineWrapping,
                EditorView.updateListener.of(update => {
                    if (update.viewportChanged
                        || update.geometryChanged
                        || update.docChanged) {
                        onViewportChange?.(editorViewportOffset(update.view));
                    }
                    if (update.docChanged && activeCorrection) {
                        activeCorrection = {
                            ...activeCorrection,
                            from: update.changes.mapPos(
                                activeCorrection.from,
                                -1
                            ),
                            to: update.changes.mapPos(activeCorrection.to, 1),
                        };
                    }
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
        for (const feature of referenceFeatureList) feature.popup.destroy();
        annotationPopup.destroy();
        imagePreview.destroy();
        removeDOMActivation();
        releaseDOMGlobals(ownerWindow);
        throw error;
    }
    const setEditingEnabled = enabled => {
        view.dispatch({
            effects: editingMode.reconfigure([
                EditorView.editable.of(enabled),
                EditorState.readOnly.of(!enabled),
            ]),
        });
    };
    const beginActiveCorrection = (block, position) => {
        if (!correctionEnabled
            || correctionBusy
            || block.type === 'table'
            || typeof onCommitCorrection !== 'function') {
            return false;
        }
        if (activeCorrection?.blockID === block.id) return true;
        if (activeCorrection) return false;
        activeCorrection = {
            blockID: block.id,
            from: block.from,
            to: block.to,
            originalMarkdown: view.state.sliceDoc(block.from, block.to),
        };
        annotationPopup.close();
        view.dispatch({
            selection: {
                anchor: Math.max(
                    block.from,
                    Math.min(position, block.to)
                ),
            },
            effects: [
                editingMode.reconfigure([
                    EditorView.editable.of(true),
                    EditorState.readOnly.of(false),
                ]),
                setInlineEditingRange.of({
                    from: block.from,
                    to: block.to,
                }),
            ],
        });
        view.focus();
        return true;
    };
    const endActiveCorrection = ({ revert = false } = {}) => {
        if (!activeCorrection) {
            setEditingEnabled(false);
            return;
        }
        const active = activeCorrection;
        const changes = revert ? {
            from: active.from,
            to: active.to,
            insert: active.originalMarkdown,
        } : undefined;
        view.dispatch({
            ...(changes ? { changes } : {}),
            effects: [
                editingMode.reconfigure([
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                ]),
                setInlineEditingRange.of(null),
            ],
        });
        activeCorrection = null;
    };
    const cancelActiveCorrection = () => {
        if (correctionBusy) return;
        endActiveCorrection({ revert: true });
    };
    const commitActiveCorrection = async () => {
        if (!activeCorrection || correctionBusy) return false;
        const active = activeCorrection;
        const replacementMarkdown = view.state.sliceDoc(active.from, active.to);
        correctionBusy = true;
        try {
            await onCommitCorrection({
                blockID: active.blockID,
                replacementMarkdown,
            });
            if (activeCorrection?.blockID === active.blockID) {
                endActiveCorrection();
            }
            return true;
        }
        catch (error) {
            if (activeCorrection?.blockID === active.blockID) {
                endActiveCorrection({ revert: true });
            }
            onCorrectionError?.(error);
            return false;
        }
        finally {
            correctionBusy = false;
        }
    };
    const startCorrectionFromDoubleClick = event => {
        if (!correctionEnabled
            || event.button !== 0
            || event.target?.closest?.('.cm-mktero-table')) {
            return;
        }
        activateDOMGlobals(ownerWindow);
        let position = view.posAtCoords?.({
            x: event.clientX,
            y: event.clientY,
        });
        if (!Number.isSafeInteger(position)) {
            try {
                position = view.posAtDOM(event.target, 0);
            }
            catch {
                return;
            }
        }
        const block = correctionBlocks.find(candidate => (
            candidate.type !== 'table'
            && position >= candidate.from
            && position <= candidate.to
        ));
        if (!block || !beginActiveCorrection(block, position)) return;
        event.preventDefault();
        event.stopPropagation();
    };
    parent.addEventListener(
        'dblclick',
        startCorrectionFromDoubleClick,
        true
    );
    const openSelectedMarkdownActions = event => {
        if (event.button !== 0) return;
        if (activeCorrection || tableCorrectionEditing) return;
        if (interactionPopups.some(popup => popup.contains(event.target))) {
            return;
        }
        activateDOMGlobals(ownerWindow);
        const domSelection = ownerWindow.document.getSelection?.();
        clampSelectionFocusToPointerLine(view, domSelection, event);
        const selection = selectedMarkdownAnnotation(view);
        if (!selection) return;
        const copyTarget = { kind: 'selection', ...selection };
        const evidence = createSourcedEvidence(
            view.state.doc.toString(),
            currentSourceMap,
            copyTarget
        );
        for (const popup of interactionPopups) {
            if (popup !== annotationPopup) popup.close();
        }
        annotationPopup.openSelection({
            anchor: selectionAnchor(
                domSelection,
                event.target,
                event
            ),
            selection,
            copyTarget,
            sourceLocation: selectionSourceLocation(
                currentSourceMap,
                copyTarget,
                view.state.doc.length
            ),
            canCopySource: Boolean(evidence),
        });
    };
    const closeSelectionActions = event => {
        const targetsPopup = annotationPopup.contains(event.target)
            || event.composedPath?.().some(target => (
                target?.nodeType && annotationPopup.contains(target)
            ));
        if (event.button === 0 && !targetsPopup) {
            annotationPopup.close();
        }
    };
    const interactionRoot = parent.getRootNode?.() || ownerWindow.document;
    const closeSelectionActionsOutsideRoot = event => {
        if (event.button !== 0) return;
        const eventPath = event.composedPath?.() || [];
        if (eventPath.includes(interactionRoot)
            || event.target === interactionRoot.host) {
            return;
        }
        annotationPopup.close();
    };
    interactionRoot.addEventListener(
        'mousedown',
        closeSelectionActions,
        true
    );
    if (interactionRoot !== ownerWindow.document) {
        ownerWindow.document.addEventListener(
            'mousedown',
            closeSelectionActionsOutsideRoot,
            true
        );
    }
    const closeSelectionActionsOnEscape = event => {
        if (event.key !== 'Escape' || !annotationPopup.isSelectionOpen()) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        annotationPopup.close();
    };
    ownerWindow.document.addEventListener(
        'keydown',
        closeSelectionActionsOnEscape,
        true
    );
    parent.addEventListener('mouseup', openSelectedMarkdownActions, true);
    let currentSourceMap = [];
    const setDocument = ({ markdown, annotationOverlay, sourceMap }) => {
        activateDOMGlobals(ownerWindow);
        activeCorrection = null;
        correctionBusy = false;
        tableCorrectionEditing = false;
        for (const feature of referenceFeatureList) {
            feature.popup.close();
            feature.highlight.cancel();
        }
        annotationPopup.close();
        const value = String(markdown || '');
        currentSourceMap = Array.isArray(sourceMap) ? sourceMap : [];
        const effects = [
            ...referenceFeatureList.map(feature => feature.effect.of(null)),
            setAnnotationOverlay.of(
                annotationOverlay || createEmptyAnnotationOverlay()
            ),
            setInlineEditingRange.of(null),
            editingMode.reconfigure([
                EditorView.editable.of(false),
                EditorState.readOnly.of(true),
            ]),
        ];
        if (value === view.state.doc.toString()) {
            view.dispatch({ effects });
            return;
        }
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value },
            effects,
        });
    };
    return {
        getMarkdown() {
            return view.state.doc.toString();
        },
        setDocument,
        setMarkdown(markdown) {
            setDocument({
                markdown,
                annotationOverlay: createEmptyAnnotationOverlay(),
            });
        },
        setCorrectionState({
            enabled = false,
            blocks = [],
            correctedBlockIDs: corrected = [],
        } = {}) {
            activateDOMGlobals(ownerWindow);
            if (!enabled && activeCorrection) cancelActiveCorrection();
            correctionEnabled = Boolean(enabled);
            correctionBlocks = Array.isArray(blocks) ? blocks : [];
            correctedBlockIDs = Array.isArray(corrected) ? corrected : [];
            view.dispatch({
                effects: setCorrectionRenderingState.of({
                    enabled: correctionEnabled,
                    blocks: correctionBlocks,
                    correctedBlockIDs,
                }),
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
        destroy() {
            if (destroyed) return;
            destroyed = true;
            activateDOMGlobals(ownerWindow);
            try {
                for (const feature of referenceFeatureList) {
                    feature.highlight.cancel();
                    feature.popup.destroy();
                }
                interactionRoot.removeEventListener(
                    'mousedown',
                    closeSelectionActions,
                    true
                );
                if (interactionRoot !== ownerWindow.document) {
                    ownerWindow.document.removeEventListener(
                        'mousedown',
                        closeSelectionActionsOutsideRoot,
                        true
                    );
                }
                ownerWindow.document.removeEventListener(
                    'keydown',
                    closeSelectionActionsOnEscape,
                    true
                );
                parent.removeEventListener(
                    'mouseup',
                    openSelectedMarkdownActions,
                    true
                );
                parent.removeEventListener(
                    'dblclick',
                    startCorrectionFromDoubleClick,
                    true
                );
                annotationPopup.destroy();
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

function editorViewportOffset(editorView) {
    const scrollTop = Number(editorView.scrollDOM?.scrollTop);
    if (!Number.isFinite(scrollTop)
        || typeof editorView.lineBlockAtHeight !== 'function') {
        return editorView.viewport.from;
    }
    try {
        return editorView.lineBlockAtHeight(Math.max(0, scrollTop + 8)).from;
    }
    catch {
        return editorView.viewport.from;
    }
}

function repairStalledViewport(editorView) {
    if (editorView.inView) return false;
    const scrollTop = Number(editorView.scrollDOM?.scrollTop);
    const clientHeight = Number(editorView.scrollDOM?.clientHeight);
    if (!Number.isFinite(scrollTop)
        || !Number.isFinite(clientHeight)
        || clientHeight <= 0) {
        return false;
    }
    const centerOffset = editorView.lineBlockAtHeight(
        Math.max(0, scrollTop + clientHeight / 2)
    ).from;
    if (centerOffset >= editorView.viewport.from
        && centerOffset <= editorView.viewport.to) {
        return false;
    }

    // Zotero's XUL tab can expose window-relative coordinates that make a
    // visible shadow-root editor look offscreen to CodeMirror. Give its
    // virtual viewport a centered target, then retain the user's scroll offset.
    try {
        editorView.dispatch({
            effects: EditorView.scrollIntoView(centerOffset, { y: 'center' }),
        });
        editorView.measure();
    }
    finally {
        editorView.scrollDOM.scrollTop = scrollTop;
    }
    return true;
}

function createSourcedEvidence(markdown, sourceMap, target) {
    try {
        return createEvidenceSnippet({ markdown, sourceMap, target });
    }
    catch {
        return null;
    }
}

function selectionSourceLocation(sourceMap, target, documentLength) {
    const range = target?.ranges?.length === 1 ? target.ranges[0] : null;
    if (!Number.isSafeInteger(range?.from)
        || !Number.isSafeInteger(range?.to)
        || range.from < 0
        || range.to <= range.from
        || range.to > documentLength) {
        return null;
    }
    const entry = findUniqueContainingSourceMapEntry(
        sourceMap,
        range,
        documentLength
    );
    const location = resolveSourceMapLocation(
        entry,
        range,
        documentLength
    ) || entry?.locations[0];
    return location ? {
        pageIndex: location.pageIndex,
        bbox: [...location.bbox],
    } : null;
}

function clampSelectionFocusToPointerLine(view, selection, pointer) {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        return;
    }
    const pointerLine = editorLineContaining(view, pointer?.target);
    const focusLine = editorLineContaining(view, selection.focusNode);
    if (!pointerLine || !focusLine || pointerLine === focusLine) return;
    const range = selection.getRangeAt(0);
    if (!pointerTouchesRect(pointer, pointerLine.getBoundingClientRect?.())
        || !Array.from(range.getClientRects?.() || []).some(rect => (
            pointerTouchesRect(pointer, rect, 8)
        ))) {
        return;
    }
    try {
        const anchorPosition = view.posAtDOM(
            selection.anchorNode,
            selection.anchorOffset
        );
        const focusPosition = view.posAtDOM(
            selection.focusNode,
            selection.focusOffset
        );
        const lineFrom = view.posAtDOM(pointerLine, 0);
        const lineTo = view.posAtDOM(
            pointerLine,
            pointerLine.childNodes.length
        );
        const forward = anchorPosition < focusPosition;
        if ((forward && (focusPosition <= lineTo || anchorPosition > lineTo))
            || (!forward
                && (focusPosition >= lineFrom || anchorPosition < lineFrom))) {
            return;
        }
        setSelectionFocus(
            selection,
            pointerLine,
            forward ? pointerLine.childNodes.length : 0,
            forward
        );
    }
    catch {
        // Stale CodeMirror DOM is ignored; the regular selection path can retry.
    }
}

function editorLineContaining(view, node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const line = element?.closest?.('.cm-line');
    return line && view.dom.contains(line) ? line : null;
}

function setSelectionFocus(selection, node, offset, forward) {
    const anchorNode = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;
    if (typeof selection.setBaseAndExtent === 'function') {
        selection.setBaseAndExtent(anchorNode, anchorOffset, node, offset);
        return;
    }
    const range = node.ownerDocument.createRange();
    if (forward) {
        range.setStart(anchorNode, anchorOffset);
        range.setEnd(node, offset);
    }
    else {
        range.setStart(node, offset);
        range.setEnd(anchorNode, anchorOffset);
    }
    selection.removeAllRanges();
    selection.addRange(range);
}

function createTimedTargetHighlight({
    ownerWindow,
    effect,
    isDestroyed,
}) {
    let timer = null;
    const cancel = () => {
        if (timer === null) return;
        ownerWindow.clearTimeout(timer);
        timer = null;
    };
    const activate = (editorView, target) => {
        cancel();
        editorView.dispatch({ effects: effect.of(target.id) });
        requestEditorScroll(
            editorView,
            target.from,
            editorView.state.doc
        );
        timer = ownerWindow.setTimeout(() => {
            timer = null;
            if (isDestroyed()) return;
            editorView.dispatch({ effects: effect.of(null) });
        }, 3000);
    };
    return { activate, cancel };
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
