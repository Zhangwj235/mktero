import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function createConfirmationDialog({ document, parent }) {
    if (!document?.createElementNS || !parent?.appendChild) {
        throw new TypeError('A document and parent are required');
    }

    const element = (tagName, attributes = {}) => {
        const node = document.createElementNS(XHTML_NAMESPACE, tagName);
        for (const [name, value] of Object.entries(attributes)) {
            node.setAttribute(name, String(value));
        }
        return node;
    };
    const backdrop = element('div', {
        class: 'mktero-confirmation-backdrop',
    });
    const dialog = element('section', {
        class: 'mktero-confirmation-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'mktero-confirmation-title',
        'aria-describedby': 'mktero-confirmation-message',
    });
    const symbol = element('div', {
        class: 'mktero-confirmation-symbol',
        'aria-hidden': 'true',
    });
    const title = element('h2', {
        id: 'mktero-confirmation-title',
        class: 'mktero-confirmation-title',
    });
    const message = element('p', {
        id: 'mktero-confirmation-message',
        class: 'mktero-confirmation-message',
    });
    const copy = element('div', { class: 'mktero-confirmation-copy' });
    copy.append(title, message);
    const header = element('header', { class: 'mktero-confirmation-header' });
    header.append(symbol, copy);
    const cancel = element('button', {
        class: 'mktero-confirmation-button mktero-confirmation-button--cancel',
        type: 'button',
        'data-confirmation-action': 'cancel',
    });
    const confirm = element('button', {
        class: 'mktero-confirmation-button mktero-confirmation-button--confirm',
        type: 'button',
        'data-confirmation-action': 'confirm',
    });
    const actions = element('footer', { class: 'mktero-confirmation-actions' });
    actions.append(cancel, confirm);
    dialog.append(header, actions);
    backdrop.appendChild(dialog);

    let destroyed = false;
    let pending = null;

    const settle = (value, { restoreFocus = true } = {}) => {
        const current = pending;
        if (!current) return;
        pending = null;
        backdrop.remove();
        current.resolve(Boolean(value));
        if (restoreFocus && current.returnFocus?.isConnected !== false) {
            current.returnFocus?.focus?.();
        }
    };
    const cancelActive = () => settle(false);
    const confirmActive = () => settle(true);
    cancel.addEventListener('click', cancelActive);
    confirm.addEventListener('click', confirmActive);
    backdrop.addEventListener('click', event => {
        if (event.target === backdrop) cancelActive();
    });
    backdrop.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelActive();
            return;
        }
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const activeElement = activeElementWithin(parent, document);
        if (event.shiftKey) {
            (activeElement === cancel ? confirm : cancel).focus?.();
        }
        else {
            (activeElement === confirm ? cancel : confirm).focus?.();
        }
    });

    return {
        confirm({
            title: titleText,
            message: messageText,
            confirmLabel,
            cancelLabel,
            tone = 'default',
            icon = LUCIDE_ICONS.triangleAlert,
            confirmIcon = LUCIDE_ICONS.check,
            returnFocus = null,
        }) {
            if (destroyed) return Promise.resolve(false);
            const focusTarget = returnFocus
                || pending?.returnFocus
                || activeElementWithin(parent, document);
            if (pending) settle(false);

            title.textContent = String(titleText || '');
            message.textContent = String(messageText || '');
            symbol.replaceChildren(createLucideIcon(document, icon, { size: 20 }));
            replaceButtonContent(document, cancel, LUCIDE_ICONS.x, cancelLabel);
            replaceButtonContent(document, confirm, confirmIcon, confirmLabel);
            backdrop.setAttribute('data-tone', tone);
            confirm.setAttribute('data-tone', tone);
            parent.appendChild(backdrop);

            const result = new Promise(resolve => {
                pending = { resolve, returnFocus: focusTarget };
            });
            queueMicrotask(() => {
                if (pending && backdrop.isConnected) cancel.focus?.();
            });
            return result;
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            settle(false, { restoreFocus: false });
            backdrop.remove();
        },
    };
}

function activeElementWithin(parent, document) {
    return parent.getRootNode?.()?.activeElement || document.activeElement;
}

function replaceButtonContent(document, button, icon, label) {
    const text = document.createElementNS(XHTML_NAMESPACE, 'span');
    text.textContent = String(label || '');
    button.replaceChildren(
        createLucideIcon(document, icon, { size: 16 }),
        text
    );
}
