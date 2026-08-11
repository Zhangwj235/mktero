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
    setTranslationRenderingState,
} from './inline-rendering.js';
import { createImagePreview } from './image-preview.js';
import { createCitationPopup } from './citation-popup.js';
import { createAnnotationPopup } from './annotation-popup.js';
import {
    isCorrectionInteractionTarget,
    isEditableTextCorrectionBlock,
} from './correction-interactions.js';
import { createFigurePreviewPopup } from './figure-preview-popup.js';
import { createTablePreviewPopup } from './table-preview-popup.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
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
    onTranslateBlock,
    onCancelTranslation,
    onTranslationError,
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
    let correctionManagementEnabled = false;
    let correctionBlocks = [];
    let correctedBlockIDs = [];
    let activeCorrection = null;
    let correctionBusy = false;
    let tableCorrectionEditing = false;
    let activeTableCorrection = null;
    let view;
    let correctionToolbar;
    let translationEnabled = false;
    const translationStates = new Map();
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
                        const state = typeof editing === 'object'
                            ? editing
                            : { editing: Boolean(editing) };
                        if (!state.editing) {
                            if (activeTableCorrection?.cancel
                                && state.cancel
                                && activeTableCorrection.cancel
                                    !== state.cancel) {
                                return;
                            }
                            activeTableCorrection = null;
                            tableCorrectionEditing = false;
                            if (!activeCorrection) correctionToolbar?.hide();
                            return;
                        }
                        if (activeCorrection) {
                            state.cancel?.();
                            return;
                        }
                        if (activeTableCorrection
                            && activeTableCorrection.cancel !== state.cancel
                            && activeTableCorrection.cancel?.() === false) {
                            state.cancel?.();
                            return;
                        }
                        activeTableCorrection = state;
                        tableCorrectionEditing = true;
                        annotationPopup.close();
                        if (typeof state.save !== 'function'
                            && typeof state.cancel !== 'function') {
                            return;
                        }
                        correctionToolbar?.show('table', {
                            onSave: state.save,
                            onCancel: state.cancel,
                            onDelete: null,
                        });
                        correctionToolbar?.setDirty(Boolean(state.dirty));
                        correctionToolbar?.setBusy(Boolean(state.busy));
                        correctionToolbar?.setError(
                            state.error ? t('revision.saveFailed') : ''
                        );
                    },
                    requestTranslation: block => requestBlockTranslation(block),
                    cancelTranslation: block => cancelBlockTranslation(block),
                    hideTranslation: block => hideBlockTranslation(block),
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
                        if (!activeCorrection
                            && !tableCorrectionEditing
                            && !translationEnabled
                            && !event.isComposing
                            && !isCorrectionInteractionTarget(event.target)
                            && ['Enter', 'F2'].includes(event.key)) {
                            const position = view.state.selection.main.head;
                            const block = correctionBlocks.find(candidate => (
                                isEditableTextCorrectionBlock(candidate)
                                && position >= candidate.from
                                && position <= candidate.to
                            ));
                            if (!block || !beginActiveCorrection(block, position)) {
                                return false;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            return true;
                        }
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
                        const dirty = update.view.state.sliceDoc(
                            activeCorrection.from,
                            activeCorrection.to
                        ) !== activeCorrection.originalMarkdown;
                        activeCorrection = { ...activeCorrection, dirty };
                        correctionToolbar?.setDirty(dirty);
                        correctionToolbar?.setError('');
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
    const dispatchTranslationState = () => {
        view.dispatch({
            effects: setTranslationRenderingState.of({
                enabled: translationEnabled,
                states: new Map(translationStates),
            }),
        });
    };
    const requestBlockTranslation = async block => {
        if (!translationEnabled
            || typeof onTranslateBlock !== 'function'
            || !block?.id
            || !block.markdown?.trim()) {
            return false;
        }
        const previous = translationStates.get(block.id);
        if (previous?.status === 'loading') return false;
        const token = {};
        translationStates.set(block.id, {
            status: 'loading',
            source: block.source,
            token,
        });
        dispatchTranslationState();
        try {
            const result = await onTranslateBlock({
                blockID: block.id,
                markdown: block.markdown,
            });
            const active = translationStates.get(block.id);
            if (active?.token !== token) return false;
            const text = String(result?.text || '').trim();
            if (!text) {
                const error = new Error('The AI translation is empty');
                error.code = 'AI_INVALID_RESPONSE';
                throw error;
            }
            translationStates.set(block.id, {
                status: 'ready',
                source: block.source,
                text,
                model: String(result?.model || ''),
            });
            dispatchTranslationState();
            return true;
        }
        catch (error) {
            const active = translationStates.get(block.id);
            if (active?.token !== token) return false;
            if (isTranslationAbort(error)) {
                translationStates.delete(block.id);
            }
            else {
                translationStates.set(block.id, {
                    status: 'error',
                    source: block.source,
                    errorKey: translationErrorKey(error),
                });
                onTranslationError?.(error);
            }
            dispatchTranslationState();
            return false;
        }
    };
    const cancelBlockTranslation = block => {
        const active = translationStates.get(block?.id);
        if (active?.status !== 'loading') return false;
        translationStates.delete(block.id);
        try {
            onCancelTranslation?.(block.id);
        }
        catch (error) {
            onTranslationError?.(error);
        }
        dispatchTranslationState();
        return true;
    };
    const hideBlockTranslation = block => {
        if (!translationStates.delete(block?.id)) return false;
        dispatchTranslationState();
        return true;
    };
    const clearTranslations = ({ cancel = true } = {}) => {
        if (cancel) {
            for (const [blockID, state] of translationStates) {
                if (state.status === 'loading') {
                    try {
                        onCancelTranslation?.(blockID);
                    }
                    catch (error) {
                        onTranslationError?.(error);
                    }
                }
            }
        }
        translationStates.clear();
    };
    const beginActiveCorrection = (block, position) => {
        if (correctionBusy
            || tableCorrectionEditing
            || translationEnabled
            || !isEditableTextCorrectionBlock(block)
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
            dirty: false,
        };
        annotationPopup.close();
        correctionToolbar?.show(block.type);
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
            correctionToolbar?.hide();
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
        correctionToolbar?.hide();
    };
    const cancelActiveCorrection = ({ force = false } = {}) => {
        if (correctionBusy && !force) return false;
        endActiveCorrection({ revert: true });
        return true;
    };
    const commitActiveCorrection = async () => {
        if (!activeCorrection || correctionBusy || !activeCorrection.dirty) {
            return false;
        }
        const active = activeCorrection;
        const replacementMarkdown = view.state.sliceDoc(active.from, active.to);
        correctionBusy = true;
        correctionToolbar?.setBusy(true);
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
                correctionToolbar?.setError(t('revision.saveFailed'));
            }
            onCorrectionError?.(error);
            return false;
        }
        finally {
            correctionBusy = false;
            correctionToolbar?.setBusy(false);
        }
    };
    const deleteActiveCorrection = () => {
        if (!activeCorrection || correctionBusy) return false;
        view.dispatch({
            changes: {
                from: activeCorrection.from,
                to: activeCorrection.to,
                insert: '',
            },
        });
        return commitActiveCorrection();
    };
    correctionToolbar = createBlockCorrectionToolbar({
        parent,
        translate: t,
        onSave: () => { void commitActiveCorrection(); },
        onCancel: cancelActiveCorrection,
        onDelete: () => { void deleteActiveCorrection(); },
    });
    const startCorrectionFromDoubleClick = event => {
        if (event.button !== 0
            || tableCorrectionEditing
            || translationEnabled
            || event.target?.closest?.('.cm-mktero-table')
            || isCorrectionInteractionTarget(event.target)) {
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
            isEditableTextCorrectionBlock(candidate)
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
        const value = String(markdown || '');
        const documentChanged = value !== view.state.doc.toString();
        if (documentChanged) clearTranslations();
        activeTableCorrection?.cancel?.({
            focus: false,
            force: true,
        });
        activeCorrection = null;
        correctionBusy = false;
        correctionToolbar?.setBusy(false);
        correctionToolbar?.hide();
        tableCorrectionEditing = false;
        activeTableCorrection = null;
        for (const feature of referenceFeatureList) {
            feature.popup.close();
            feature.highlight.cancel();
        }
        annotationPopup.close();
        currentSourceMap = Array.isArray(sourceMap) ? sourceMap : [];
        const effects = [
            ...referenceFeatureList.map(feature => feature.effect.of(null)),
            setAnnotationOverlay.of(
                annotationOverlay || createEmptyAnnotationOverlay()
            ),
            setInlineEditingRange.of(null),
            setTranslationRenderingState.of({
                enabled: translationEnabled,
                states: new Map(translationStates),
            }),
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
            const nextManagementEnabled = Boolean(enabled);
            const nextCorrectionBlocks = Array.isArray(blocks) ? blocks : [];
            const activeBlockAvailable = !activeCorrection
                || nextCorrectionBlocks.some(block => (
                    block?.id === activeCorrection.blockID
                ));
            if (activeCorrection
                && ((!nextManagementEnabled && correctionManagementEnabled)
                    || !activeBlockAvailable)) {
                cancelActiveCorrection();
            }
            correctionManagementEnabled = nextManagementEnabled;
            correctionBlocks = nextCorrectionBlocks;
            correctedBlockIDs = Array.isArray(corrected) ? corrected : [];
            view.dispatch({
                effects: setCorrectionRenderingState.of({
                    enabled: correctionManagementEnabled,
                    blocks: correctionBlocks,
                    correctedBlockIDs,
                }),
            });
            repairStalledViewport(view);
        },
        setTranslationState({ enabled = false } = {}) {
            activateDOMGlobals(ownerWindow);
            const nextEnabled = Boolean(enabled)
                && typeof onTranslateBlock === 'function';
            if (nextEnabled) {
                cancelActiveCorrection({ force: true });
                activeTableCorrection?.cancel?.({
                    focus: false,
                    force: true,
                });
            }
            if (!nextEnabled && translationEnabled) clearTranslations();
            translationEnabled = nextEnabled;
            dispatchTranslationState();
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
                clearTranslations();
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
                correctionToolbar?.destroy();
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

function createBlockCorrectionToolbar({
    parent,
    translate,
    onSave,
    onCancel,
    onDelete,
}) {
    const document = parent.ownerDocument;
    const toolbar = createHTMLNode(document, 'div');
    toolbar.className = 'mktero-correction-editor-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute(
        'aria-label',
        translate('revision.editorActions')
    );
    toolbar.hidden = true;

    const deleteButton = createCorrectionToolbarButton(
        document,
        'mktero-correction-editor-delete'
    );
    const cancelButton = createCorrectionToolbarButton(
        document,
        'mktero-correction-editor-cancel',
        translate('revision.cancel')
    );
    const saveButton = createCorrectionToolbarButton(
        document,
        'mktero-correction-editor-save',
        translate('revision.saveChanges')
    );
    const status = createHTMLNode(document, 'span');
    status.className = 'mktero-correction-editor-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    toolbar.append(status, deleteButton, cancelButton, saveButton);

    let activeActions = { onSave, onCancel, onDelete };
    let busy = false;
    let dirty = false;
    let errorMessage = '';
    parent.append(toolbar);

    const listeners = [
        [deleteButton, 'onDelete'],
        [cancelButton, 'onCancel'],
        [saveButton, 'onSave'],
    ].map(([button, actionName]) => {
        const listener = event => {
            event.preventDefault();
            event.stopPropagation();
            activeActions[actionName]?.();
        };
        button.addEventListener('click', listener);
        return { button, listener };
    });

    const syncButtonState = () => {
        deleteButton.disabled = busy;
        cancelButton.disabled = busy;
        saveButton.disabled = busy || !dirty;
    };

    const syncStatus = () => {
        const message = errorMessage || (
            dirty ? translate('revision.unsavedChanges') : ''
        );
        status.textContent = message;
        status.hidden = !message;
    };

    return {
        show(blockType, actions = {}) {
            activeActions = {
                onSave,
                onCancel,
                onDelete,
                ...actions,
            };
            const key = blockType === 'heading'
                ? 'revision.deleteHeading'
                : 'revision.deleteParagraph';
            const label = translate(key);
            deleteButton.textContent = label;
            deleteButton.setAttribute('aria-label', label);
            deleteButton.setAttribute('title', label);
            deleteButton.hidden = blockType === 'table'
                || typeof activeActions.onDelete !== 'function';
            busy = false;
            dirty = false;
            this.setError('');
            syncButtonState();
            toolbar.hidden = false;
        },
        hide() {
            toolbar.hidden = true;
            errorMessage = '';
            status.hidden = true;
        },
        setBusy(nextBusy) {
            busy = Boolean(nextBusy);
            toolbar.setAttribute('aria-busy', String(busy));
            syncButtonState();
        },
        setDirty(nextDirty) {
            dirty = Boolean(nextDirty);
            syncButtonState();
            syncStatus();
        },
        setError(message) {
            errorMessage = message || '';
            syncStatus();
        },
        destroy() {
            for (const { button, listener } of listeners) {
                button.removeEventListener('click', listener);
            }
            toolbar.remove();
        },
    };
}

function createCorrectionToolbarButton(document, className, label = '') {
    const button = createHTMLNode(document, 'button');
    button.type = 'button';
    button.className = [
        'mktero-correction-editor-button',
        className,
    ].join(' ');
    button.textContent = label;
    if (label) {
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
    }
    return button;
}

function createHTMLNode(document, tagName) {
    if (typeof document.createElementNS === 'function') {
        return document.createElementNS(XHTML_NAMESPACE, tagName);
    }
    return document.createElement(tagName);
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

function translationErrorKey(error) {
    switch (error?.code) {
        case 'AI_CONFIGURATION_ERROR':
        case 'AI_PROVIDER_UNSUPPORTED':
            return 'ai.configurationRequired';
        case 'AI_AUTH_ERROR':
            return 'ai.authenticationFailed';
        case 'AI_RATE_LIMITED':
            return 'ai.rateLimited';
        case 'AI_REQUEST_TIMEOUT':
            return 'ai.requestTimedOut';
        default:
            return 'ai.translationFailed';
    }
}

function isTranslationAbort(error) {
    return error?.name === 'AbortError'
        || error?.code === 'ABORT_ERR'
        || error?.code === 'AI_REQUEST_ABORTED';
}
