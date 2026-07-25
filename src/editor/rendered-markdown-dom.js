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
