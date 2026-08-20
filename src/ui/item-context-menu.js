import { translateEnglish } from '../i18n/localization.js';
import { isSavedMarkdownNote as isMarkedSavedMarkdownNote } from '../core/saved-markdown-note-format.js';

const ITEM_MENU_ID = 'zotero-itemmenu';
const MENU_ITEM_ID = 'mktero-read-as-markdown';
const GRAPH_MENU_ITEM_ID = 'mktero-open-citation-graph';

export function registerItemContextMenu({
    zotero,
    window,
    rootURI,
    onOpen,
    onOpenCitationGraph = null,
    onOpenSavedNote = null,
    isSavedMarkdownNote = defaultIsSavedMarkdownNote,
    onError,
    translate = translateEnglish,
}) {
    const document = window?.document;
    const menu = document?.getElementById?.(ITEM_MENU_ID);
    if (!menu) return null;

    document.getElementById(MENU_ITEM_ID)?.remove();
    document.getElementById(GRAPH_MENU_ITEM_ID)?.remove();

    const menuItem = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    menuItem.id = MENU_ITEM_ID;
    menuItem.hidden = true;
    menuItem.setAttribute('label', translate('menu.readAsMarkdown'));
    menuItem.setAttribute('class', 'menuitem-iconic');
    menuItem.setAttribute('image', `${rootURI}ui/icons/mktero.svg`);
    const graphMenuItem = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    graphMenuItem.id = GRAPH_MENU_ITEM_ID;
    graphMenuItem.hidden = true;
    graphMenuItem.setAttribute(
        'label',
        translate('menu.openCitationGraph')
    );
    graphMenuItem.setAttribute('class', 'menuitem-iconic');
    graphMenuItem.setAttribute('image', `${rootURI}ui/icons/mktero.svg`);

    const handlePopupShowing = event => {
        if (event.target !== menu) return;
        const selected = resolveSelectedItem(
            zotero,
            window,
            isSavedMarkdownNote
        );
        menuItem.hidden = !selected
            || (selected.kind === 'saved-markdown-note'
                && typeof onOpenSavedNote !== 'function');
        menuItem.setAttribute(
            'label',
            translate(selected?.kind === 'saved-markdown-note'
                ? 'menu.openSavedMarkdown'
                : 'menu.readAsMarkdown')
        );
        graphMenuItem.hidden = typeof onOpenCitationGraph !== 'function'
            || !resolveSelectedGraphItem(window);
    };
    const handleCommand = () => {
        const selected = resolveSelectedItem(
            zotero,
            window,
            isSavedMarkdownNote
        );
        if (!selected) return;
        Promise.resolve()
            .then(() => selected.kind === 'saved-markdown-note'
                ? onOpenSavedNote?.(selected.item.id)
                : onOpen(selected.item.id))
            .catch(onError);
    };
    const handleGraphCommand = () => {
        const selected = resolveSelectedGraphItem(window);
        if (!selected || typeof onOpenCitationGraph !== 'function') return;
        Promise.resolve()
            .then(() => onOpenCitationGraph(selected.id))
            .catch(onError);
    };

    menu.addEventListener('popupshowing', handlePopupShowing);
    menuItem.addEventListener('command', handleCommand);
    graphMenuItem.addEventListener('command', handleGraphCommand);
    menu.append(menuItem, graphMenuItem);

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        menu.removeEventListener('popupshowing', handlePopupShowing);
        menuItem.removeEventListener('command', handleCommand);
        graphMenuItem.removeEventListener('command', handleGraphCommand);
        menuItem.remove();
        graphMenuItem.remove();
    };
}

function resolveSelectedGraphItem(window) {
    const selectedItems = window?.ZoteroPane?.getSelectedItems?.();
    if (!Array.isArray(selectedItems) || selectedItems.length !== 1) return null;
    const item = selectedItems[0];
    return item?.isPDFAttachment?.() || item?.isRegularItem?.() ? item : null;
}

function resolveSelectedItem(zotero, window, isSavedMarkdownNote) {
    const selectedItems = window?.ZoteroPane?.getSelectedItems?.();
    if (!Array.isArray(selectedItems) || selectedItems.length !== 1) return null;

    const item = selectedItems[0];
    if (isSavedMarkdownNote(item)) {
        return { kind: 'saved-markdown-note', item };
    }
    if (item?.isPDFAttachment?.()) return { kind: 'pdf', item };
    if (!item?.isRegularItem?.()) return null;

    for (const attachmentID of item.getAttachments?.() || []) {
        const attachment = zotero?.Items?.get?.(attachmentID);
        if (attachment?.isPDFAttachment?.()) {
            return { kind: 'pdf', item: attachment };
        }
    }
    return null;
}

function defaultIsSavedMarkdownNote(item) {
    return Boolean(item?.isNote?.()
        && isMarkedSavedMarkdownNote(item.getNote?.() || ''));
}
