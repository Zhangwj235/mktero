import { renderMarkdownHTML } from '../markdown/markdown-html.js';

export function appendRenderedMarkdown(
    container,
    source,
    resolveImageURL,
    unwrapParagraph = false
) {
    const document = container.ownerDocument;
    const html = renderMarkdownHTML(source, { resolveImageURL });
    const DOMParserType = document.defaultView.DOMParser;
    const parsed = new DOMParserType().parseFromString(
        `<!doctype html><html><body>${html}</body></html>`,
        'text/html'
    );
    let nodes = [...parsed.body.childNodes];
    if (unwrapParagraph && nodes.length === 1 && nodes[0].localName === 'p') {
        nodes = [...nodes[0].childNodes];
    }
    container.append(...nodes.map(node => document.importNode(node, true)));
}

export function openRenderedLink(event, openLink) {
    if (event.button !== 0) return false;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return false;
    event.preventDefault();
    openLink?.(anchor.getAttribute('href') || '');
    return true;
}

export function installRenderedImagePreview(container, openImagePreview) {
    for (const image of container.querySelectorAll('img')) {
        const alt = image.getAttribute('alt') || '图片';
        image.setAttribute('role', 'button');
        image.setAttribute('tabindex', '0');
        image.setAttribute('aria-haspopup', 'dialog');
        image.setAttribute('aria-label', `预览图片：${alt}`);
    }
    container.addEventListener('mousedown', event => {
        if (!event.target?.closest?.('img')) return;
        event.preventDefault();
    });
    container.addEventListener('click', event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
        openImage(event.target?.closest?.('img'), event, openImagePreview);
    });
    container.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        openImage(event.target?.closest?.('img'), event, openImagePreview);
    });
}

function openImage(image, event, openImagePreview) {
    if (!image) return false;
    event.preventDefault();
    event.stopPropagation();
    openImagePreview?.({
        src: image.currentSrc || image.getAttribute('src') || '',
        alt: image.getAttribute('alt') || '',
    });
    return true;
}
