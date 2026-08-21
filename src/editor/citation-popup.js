import { createAnchoredPopup } from './anchored-popup.js';
import { createLocalization } from '../i18n/localization.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function createCitationPopup(parent, {
    localization = createLocalization(),
} = {}) {
    const t = localization.t.bind(localization);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-citation-popup',
        idPrefix: 'mktero-citation-popup',
    });
    let activeAnchor = null;
    let activeController = null;

    const open = ({
        anchor,
        targets,
        label = t('citation.details'),
        onActivate,
        focusFirst = false,
        sourceItemID = null,
        onListReferenceLibraries,
        onGetReferenceStatus,
        onImportReference,
        onOpenReferenceMatch,
        onSubscribeReferenceUpdates,
        targetLibraryID = null,
    }) => {
        if (!targets?.length) return;
        if (activeAnchor === anchor && anchoredPopup.isOpen()) {
            anchoredPopup.open({
                anchor,
                label,
                renderContent: () => null,
                forceOpen: focusFirst,
                focusContent: focusFirst ? focusFirstItem : null,
            });
            return;
        }
        activeController?.abort?.();
        const controller = createAbortController(parent);
        activeController = controller;
        activeAnchor = anchor;
        let generation = 0;
        let selectedLibraryID = targetLibraryID;
        let libraries = [];
        let rows = [];
        let contentRoot = null;
        let unsubscribeUpdates = null;

        const isCurrent = expectedGeneration => (
            activeController === controller
            && activeAnchor === anchor
            && !controller.signal?.aborted
            && generation === expectedGeneration
        );
        const close = () => anchoredPopup.close();
        const refreshRows = () => {
            const currentGeneration = ++generation;
            for (const row of rows) {
                void updateReferenceRow({
                    row,
                    target: row.target,
                    selectedLibraryID,
                    generation: currentGeneration,
                    isCurrent,
                    controller,
                    onGetReferenceStatus,
                    onImportReference,
                    onOpenReferenceMatch,
                    close,
                    t,
                });
            }
        };
        const loadLibraries = async () => {
            if (typeof onListReferenceLibraries !== 'function') return;
            try {
                const result = await onListReferenceLibraries({
                    sourceItemID,
                    signal: controller.signal,
                });
                if (controller.signal?.aborted || activeAnchor !== anchor) return;
                libraries = Array.isArray(result) ? result : result?.libraries || [];
                const preferredLibraryID = selectedLibraryID
                    ?? result?.defaultLibraryID;
                selectedLibraryID = libraries.find(library => (
                    String(library.libraryID) === String(preferredLibraryID)
                ))?.libraryID
                    ?? libraries.find(library => library.type === 'user')?.libraryID
                    ?? libraries[0]?.libraryID
                    ?? null;
                renderLibrarySelector(contentRoot, {
                    libraries,
                    selectedLibraryID,
                    onChange(nextID) {
                        selectedLibraryID = nextID;
                        refreshRows();
                    },
                    t,
                });
                refreshRows();
            }
            catch {
                if (controller.signal?.aborted || activeAnchor !== anchor) return;
                renderLibraryError(contentRoot, t('reference.libraryLoadFailed'));
            }
        };

        anchoredPopup.open({
            anchor,
            label,
            forceOpen: focusFirst,
            onClose() {
                controller.abort?.();
                unsubscribeUpdates?.();
                unsubscribeUpdates = null;
                if (activeController === controller) activeController = null;
                if (activeAnchor === anchor) activeAnchor = null;
            },
            renderContent({ document }) {
                contentRoot = createElement(document, 'div');
                contentRoot.className = 'mktero-citation-popup-content';
                if (typeof onListReferenceLibraries === 'function') {
                    const header = createElement(document, 'div');
                    header.className = 'mktero-citation-popup-header';
                    const labelElement = createElement(document, 'label');
                    labelElement.textContent = t('reference.targetLibrary');
                    const select = createElement(document, 'select');
                    select.className = 'mktero-citation-popup-library-select';
                    select.disabled = true;
                    select.setAttribute('aria-busy', 'true');
                    select.setAttribute('aria-label', t('reference.targetLibrary'));
                    appendSelectPlaceholder(
                        select,
                        t('reference.loadingLibraries'),
                        document
                    );
                    header.append(labelElement, select);
                    contentRoot.appendChild(header);
                }
                rows = targets.map(target => createCitationItem({
                    document,
                    target,
                    close,
                    onActivate,
                    rowOptions: {
                        selectedLibraryID: () => selectedLibraryID,
                        isCurrent,
                        controller,
                        onGetReferenceStatus,
                        onImportReference,
                        onOpenReferenceMatch,
                        close,
                        t,
                    },
                }));
                for (const row of rows) contentRoot.appendChild(row.element);
                void loadLibraries();
                if (typeof onGetReferenceStatus === 'function') refreshRows();
                if (typeof onSubscribeReferenceUpdates === 'function') {
                    unsubscribeUpdates = onSubscribeReferenceUpdates(() => {
                        if (!controller.signal?.aborted) refreshRows();
                    });
                }
                return contentRoot;
            },
            focusContent: focusFirst ? focusFirstItem : null,
        });
    };

    return {
        open,
        close: anchoredPopup.close,
        scheduleClose: anchoredPopup.scheduleClose,
        cancelClose: anchoredPopup.cancelClose,
        contains: anchoredPopup.contains,
        destroy() {
            activeController?.abort?.();
            activeController = null;
            activeAnchor = null;
            anchoredPopup.destroy();
        },
    };
}

function createCitationItem({
    document,
    target,
    close,
    onActivate,
    rowOptions,
}) {
    const element = createElement(document, 'div');
    element.className = 'mktero-citation-popup-item';
    const primary = createElement(document, 'button');
    primary.type = 'button';
    primary.className = 'mktero-citation-popup-primary';
    primary.addEventListener('click', event => {
        event.stopPropagation();
        close();
        onActivate?.(target);
    });
    const marker = target.label
        ?? (Number.isInteger(target.number) ? String(target.number) : '');
    if (marker) {
        const number = createElement(document, 'span');
        number.className = 'mktero-citation-popup-number';
        number.textContent = `[${marker}]`;
        primary.appendChild(number);
    }
    const text = createElement(document, 'span');
    text.className = 'mktero-citation-popup-text';
    text.textContent = target.text;
    primary.appendChild(text);

    const controls = createElement(document, 'div');
    controls.className = 'mktero-citation-popup-actions';
    const status = createElement(document, 'span');
    status.className = 'mktero-citation-popup-status';
    status.setAttribute('role', 'status');
    const action = createElement(document, 'button');
    action.type = 'button';
    action.className = 'mktero-citation-popup-action';
    action.hidden = true;
    action.addEventListener('click', event => {
        event.stopPropagation();
        void runReferenceAction({
            target,
            row: { status, action, target },
            options: rowOptions,
        });
    });
    controls.append(status, action);
    element.append(primary, controls);
    return { element, target, status, action };
}

async function updateReferenceRow({
    row,
    target,
    selectedLibraryID,
    generation,
    isCurrent,
    controller,
    onGetReferenceStatus,
    onImportReference,
    onOpenReferenceMatch,
    close,
    t,
}) {
    if (!row?.status || !isReferenceTarget(target)) return;
    setStatus(row, 'checking', t);
    if (typeof onGetReferenceStatus !== 'function') {
        setStatus(row, 'unknown', t);
        return;
    }
    try {
        const result = await onGetReferenceStatus(target, {
            targetLibraryID: selectedLibraryID,
            signal: controller.signal,
        });
        if (!isCurrent(generation)) return;
        applyStatus(row, result, {
            target,
            selectedLibraryID,
            onImportReference,
            onOpenReferenceMatch,
            close,
            controller,
            generation,
            isCurrent,
            t,
        });
    }
    catch (error) {
        if (!isCurrent(generation) || error?.name === 'AbortError') return;
        row.status.textContent = errorLabel(error?.code, t);
        row.status.dataset.state = 'failed';
        row.action.hidden = true;
    }
}

function applyStatus(row, result, {
    target,
    selectedLibraryID,
    onImportReference,
    onOpenReferenceMatch,
    close,
    controller,
    generation = null,
    isCurrent = () => true,
    t,
}) {
    const state = result?.state || result?.status || 'unknown';
    const selectedMatch = result?.match || result?.selectedMatches?.[0] || null;
    const otherLibraries = [...new Set((result?.otherMatches || [])
        .map(match => match?.libraryName || match?.libraryID)
        .filter(Boolean))];
    row.status.textContent = state === 'present-other-library'
        && otherLibraries.length
        ? t('reference.presentOtherLibrary', {
            library: otherLibraries.join(', '),
        })
        : state === 'failed'
            ? errorLabel(result?.errorCode, t)
            : statusLabel(state, t);
    if (result?.targetLibraryEditable === false
        && state !== 'present'
        && state !== 'present-no-pdf') {
        row.status.textContent += ` · ${t('reference.readOnly')}`;
    }
    if (state === 'present-no-pdf'
        && result?.targetLibraryFilesEditable === false) {
        row.status.textContent += ` · ${t('reference.filesReadOnly')}`;
    }
    row.status.dataset.state = state;
    row.action.hidden = true;
    row.action.disabled = false;
    row.action.textContent = '';
    row.action._mkteroAction = null;
    row.action._mkteroActionKind = null;
    row.action._mkteroActionGeneration = null;
    row.action._mkteroActionIsCurrent = null;
    if ((state === 'present' || state === 'imported')
        && selectedMatch
        && typeof onOpenReferenceMatch === 'function') {
        configureAction(
            row.action,
            t('reference.open'),
            () => onOpenReferenceMatch(selectedMatch),
            'open',
            generation,
            isCurrent
        );
    }
    else if (state === 'present-no-pdf'
        && result?.canImport !== false
        && result?.filesEditable !== false
        && typeof onImportReference === 'function') {
        configureAction(
            row.action,
            t('reference.retryPDF'),
            () => onImportReference(target, {
                targetLibraryID: selectedLibraryID,
                signal: controller.signal,
                retryPDF: true,
            }),
            'import',
            generation,
            isCurrent
        );
    }
    else if (state === 'present-other-library'
        && result?.canImport !== false
        && typeof onImportReference === 'function') {
        configureAction(
            row.action,
            t('reference.copyToLibrary'),
            () => onImportReference(target, {
                targetLibraryID: selectedLibraryID,
                signal: controller.signal,
            }),
            'import',
            generation,
            isCurrent
        );
    }
    else if (state === 'absent'
        && result?.canImport !== false
        && typeof onImportReference === 'function') {
        configureAction(
            row.action,
            t('reference.import'),
            () => onImportReference(target, {
                targetLibraryID: selectedLibraryID,
                signal: controller.signal,
            }),
            'import',
            generation,
            isCurrent
        );
    }
    else if (state === 'failed'
        && result?.canImport !== false
        && typeof onImportReference === 'function') {
        configureAction(
            row.action,
            t('reference.retry'),
            () => onImportReference(target, {
                targetLibraryID: selectedLibraryID,
                signal: controller.signal,
            }),
            'import',
            generation,
            isCurrent
        );
    }
}

async function runReferenceAction({ target, row, options }) {
    const {
        selectedLibraryID,
        onImportReference,
        onOpenReferenceMatch,
        close,
        controller,
        t,
    } = options;
    if (typeof row.action._mkteroAction !== 'function') return;
    const actionGeneration = row.action._mkteroActionGeneration;
    if (actionGeneration !== null
        && actionGeneration !== undefined
        && !options.isCurrent?.(actionGeneration)) return;
    try {
        if (row.action._mkteroActionKind === 'open') {
            await row.action._mkteroAction();
            options.close?.();
            return;
        }
        row.action.disabled = true;
        row.action.textContent = t('reference.importing');
        row.status.textContent = t('reference.importing');
        row.status.dataset.state = 'importing';
        const result = await row.action._mkteroAction({
            target,
            targetLibraryID: selectedLibraryID(),
            signal: controller.signal,
        });
        if (result) {
            if (actionGeneration !== null
                && actionGeneration !== undefined
                && !options.isCurrent?.(actionGeneration)) return;
            applyStatus(row, result, {
                target,
                selectedLibraryID: selectedLibraryID(),
                onImportReference,
                onOpenReferenceMatch,
                close: () => {},
                controller,
                generation: actionGeneration,
                isCurrent: options.isCurrent,
                t,
            });
        }
    }
    catch (error) {
        if (error?.name === 'AbortError') return;
        row.action.disabled = false;
        row.status.textContent = errorLabel(error?.code, t);
        row.status.dataset.state = 'failed';
    }
}

function configureAction(
    button,
    label,
    action,
    kind = 'import',
    generation = null,
    isCurrent = () => true
) {
    button.hidden = false;
    button.textContent = label;
    button._mkteroAction = action;
    button._mkteroActionKind = kind;
    button._mkteroActionGeneration = generation;
    button._mkteroActionIsCurrent = isCurrent;
}

function setStatus(row, state, t) {
    row.status.textContent = statusLabel(state, t);
    row.status.dataset.state = state;
    row.action.hidden = true;
    row.action._mkteroAction = null;
    row.action._mkteroActionKind = null;
    row.action._mkteroActionGeneration = null;
    row.action._mkteroActionIsCurrent = null;
}

function statusLabel(state, t) {
    const keys = {
        checking: 'reference.checking',
        present: 'reference.present',
        'present-no-pdf': 'reference.presentNoPDF',
        'present-other-library': 'reference.presentOtherLibrary',
        absent: 'reference.absent',
        ambiguous: 'reference.ambiguous',
        unknown: 'reference.unknown',
        importing: 'reference.importing',
        imported: 'reference.imported',
        failed: 'reference.failed',
    };
    return t(keys[state] || keys.unknown);
}

function errorLabel(errorCode, t) {
    const keys = {
        REFERENCE_IDENTIFIER_UNSUPPORTED: 'reference.errorUnsupported',
        REFERENCE_LIBRARY_READ_ONLY: 'reference.errorLibraryReadOnly',
        REFERENCE_FILES_READ_ONLY: 'reference.errorFilesReadOnly',
        REFERENCE_TRANSLATOR_UNAVAILABLE: 'reference.errorTranslator',
        REFERENCE_TRANSLATOR_NOT_FOUND: 'reference.errorTranslator',
        REFERENCE_TRANSLATOR_EMPTY: 'reference.errorTranslator',
        REFERENCE_DUPLICATE_RACE: 'reference.errorDuplicate',
        REFERENCE_NETWORK_FAILED: 'reference.errorNetwork',
        REFERENCE_PDF_FAILED: 'reference.errorPDF',
    };
    return t(keys[errorCode] || 'reference.errorImport');
}

function renderLibrarySelector(root, {
    libraries,
    selectedLibraryID,
    onChange,
    t,
}) {
    const select = root?.querySelector?.('.mktero-citation-popup-library-select');
    if (!select) return;
    clearChildren(select);
    const availableLibraries = Array.isArray(libraries) ? libraries : [];
    if (!availableLibraries.length) {
        appendSelectPlaceholder(
            select,
            t('reference.noLibraries'),
            root.ownerDocument
        );
    }
    for (const library of availableLibraries) {
        const option = createElement(root.ownerDocument, 'option');
        option.value = String(library.libraryID);
        option.textContent = library.editable
            ? library.name
            : `${library.name} — ${t('reference.readOnly')}`;
        // Keep read-only libraries selectable so the row can explain why
        // import actions are unavailable for that target.
        option.disabled = false;
        if (!library.editable) {
            option.title = t('reference.errorLibraryReadOnly');
        }
        select.appendChild(option);
    }
    if (availableLibraries.length) {
        const selected = availableLibraries.find(library => (
            String(library.libraryID) === String(selectedLibraryID)
        )) || availableLibraries[0];
        select.value = String(selected.libraryID);
    }
    select.disabled = !availableLibraries.length;
    select.setAttribute('aria-busy', 'false');
    select.title = '';
    select.onchange = () => onChange(select.value);
    select.setAttribute('aria-label', t('reference.targetLibrary'));
}

function renderLibraryError(root, message) {
    const select = root?.querySelector?.('.mktero-citation-popup-library-select');
    if (!select) return;
    clearChildren(select);
    appendSelectPlaceholder(select, message, root.ownerDocument);
    select.disabled = true;
    select.setAttribute('aria-busy', 'false');
    select.title = message;
}

function clearChildren(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
}

function appendSelectPlaceholder(select, text, document) {
    const option = createElement(document, 'option');
    option.value = '';
    option.textContent = text;
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
}

function createElement(document, name) {
    return document.createElementNS?.(XHTML_NAMESPACE, name)
        || document.createElement(name);
}

function isReferenceTarget(target) {
    return Boolean(target && !target.affiliation);
}

function createAbortController(parent) {
    const AbortControllerClass = parent.ownerDocument?.defaultView?.AbortController
        || globalThis.AbortController;
    return typeof AbortControllerClass === 'function'
        ? new AbortControllerClass()
        : { signal: {}, abort() {} };
}

function focusFirstItem(popup) {
    popup.querySelector('.mktero-citation-popup-primary')?.focus();
}
