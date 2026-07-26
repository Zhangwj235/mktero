let nextPopupID = 1;

export function createCitationPopup(parent) {
    const document = parent.ownerDocument;
    const ownerWindow = document.defaultView;
    let popup = null;
    let anchor = null;
    let ignoredOpenAnchor = null;
    let closeTimer = null;

    const cancelClose = () => {
        if (closeTimer === null) return;
        ownerWindow.clearTimeout(closeTimer);
        closeTimer = null;
    };

    const close = () => {
        cancelClose();
        if (anchor && popup
            && anchor.getAttribute('aria-describedby') === popup.id) {
            anchor.removeAttribute('aria-describedby');
        }
        popup?.remove();
        popup = null;
        anchor = null;
    };

    const scheduleClose = () => {
        cancelClose();
        closeTimer = ownerWindow.setTimeout(close, 120);
    };

    const open = ({
        anchor: nextAnchor,
        references,
        onActivate,
        focusFirst = false,
    }) => {
        if (!nextAnchor || !references?.length) return;
        if (ignoredOpenAnchor === nextAnchor) {
            ignoredOpenAnchor = null;
            return;
        }
        if (anchor === nextAnchor && popup) {
            cancelClose();
            if (focusFirst) focusFirstItem(popup);
            return;
        }
        close();
        anchor = nextAnchor;
        popup = document.createElement('div');
        popup.id = `mktero-citation-popup-${nextPopupID++}`;
        popup.className = 'mktero-citation-popup';
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-label', '引用详情');
        const content = document.createElement('div');
        content.className = 'mktero-citation-popup-content';

        for (const reference of references) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'mktero-citation-popup-item';
            item.addEventListener('click', () => {
                close();
                onActivate?.(reference);
            });
            if (Number.isInteger(reference.number)) {
                const number = document.createElement('span');
                number.className = 'mktero-citation-popup-number';
                number.textContent = `[${reference.number}]`;
                item.appendChild(number);
            }
            const text = document.createElement('span');
            text.className = 'mktero-citation-popup-text';
            text.textContent = reference.text;
            item.appendChild(text);
            content.appendChild(item);
        }

        popup.appendChild(content);
        popup.addEventListener('mouseenter', cancelClose);
        popup.addEventListener('mouseleave', scheduleClose);
        popup.addEventListener('focusin', cancelClose);
        popup.addEventListener('focusout', event => {
            if (!popup?.contains(event.relatedTarget)) scheduleClose();
        });
        popup.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            const returnFocus = anchor;
            event.preventDefault();
            event.stopPropagation();
            close();
            ignoredOpenAnchor = returnFocus;
            returnFocus?.focus();
            ownerWindow.setTimeout(() => {
                if (ignoredOpenAnchor === returnFocus) ignoredOpenAnchor = null;
            }, 0);
        });
        parent.appendChild(popup);
        anchor.setAttribute('aria-describedby', popup.id);
        positionPopup(popup, anchor, ownerWindow);
        if (focusFirst) focusFirstItem(popup);
    };

    return {
        open,
        close,
        scheduleClose,
        cancelClose,
        contains(element) {
            return Boolean(element && popup?.contains(element));
        },
        destroy: close,
    };
}

function focusFirstItem(popup) {
    popup.querySelector('.mktero-citation-popup-item')?.focus();
}

function positionPopup(popup, anchor, ownerWindow) {
    const gap = 10;
    const viewportPadding = 12;
    const anchorRect = anchor.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const viewportWidth = ownerWindow.innerWidth || 1024;
    const viewportHeight = ownerWindow.innerHeight || 768;
    const width = Math.min(popupRect.width, viewportWidth - viewportPadding * 2);
    const preferredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
    const left = clamp(
        preferredLeft,
        viewportPadding,
        Math.max(viewportPadding, viewportWidth - width - viewportPadding)
    );
    const above = anchorRect.top - popupRect.height - gap;
    const below = anchorRect.bottom + gap;
    const placeAbove = above >= viewportPadding || below + popupRect.height > viewportHeight;
    const arrowLeft = clamp(
        anchorRect.left + anchorRect.width / 2 - left,
        12,
        Math.max(12, width - 12)
    );
    popup.dataset.placement = placeAbove ? 'top' : 'bottom';
    popup.style.setProperty('--citation-arrow-left', `${Math.round(arrowLeft)}px`);
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(placeAbove ? Math.max(viewportPadding, above) : below)}px`;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}
