import { renderMarkdownHTML } from '../markdown/markdown-html.js';
import { createLoadingPresentation } from './markdown-loading-state.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function createMarkdownTabView({ document, rootURI, model, zotero }) {
    return new MarkdownTabView({ document, rootURI, model, zotero });
}

class MarkdownTabView {
    constructor({ document, rootURI, model, zotero }) {
        if (!document?.createElementNS) {
            throw new Error('The Zotero window cannot create the Markdown view');
        }

        this.document = document;
        this.ownerWindow = document.defaultView || globalThis;
        this.zotero = zotero;
        this.model = model;
        this.renderedAssets = undefined;
        this.assetURLs = new Map();
        this.listeners = [];

        this.host = this.createElement('div', {
            class: 'mktero-tab-host',
            role: 'region',
            'aria-label': 'Mktero Markdown viewer',
        });
        Object.assign(this.host.style, {
            display: 'block',
            width: '100%',
            height: '100%',
            minWidth: '0',
            minHeight: '0',
            overflow: 'hidden',
        });
        if (!this.host.attachShadow) {
            throw new Error('The Zotero window does not support an isolated Markdown view');
        }

        this.root = this.createLayoutRoot();
        this.mount = this.host.attachShadow({ mode: 'open' });
        this.mount.appendChild(this.createStylesheet(rootURI));
        this.elements = this.createContent();
        this.mount.appendChild(this.elements.view);
        this.bindActions();
    }

    render(model = this.model) {
        this.model = model;
        const elements = this.elements;
        const loadingView = createLoadingPresentation(model);
        const showContent = model.status === 'ready' || loadingView.preserveContent;

        elements.progress.hidden = !loadingView.visible;
        elements.progress.value = loadingView.progress || 0;
        elements.loading.hidden = !loadingView.visible;
        elements.loading.classList.toggle(
            'loading-state--inline',
            loadingView.preserveContent
        );
        elements.content.setAttribute('aria-busy', String(loadingView.visible));
        elements.error.hidden = model.status !== 'error';
        elements.error.textContent = model.error || '';
        elements.warning.hidden = !model.warnings?.length;
        elements.warning.textContent = model.warnings?.join(' ') || '';
        elements.previewButton.disabled = !showContent;
        elements.sourceButton.disabled = !showContent;
        this.syncContentVisibility(showContent);

        if (loadingView.visible) {
            elements.status.textContent = `${loadingView.title} ${loadingView.progressLabel}`;
            elements.loadingTitle.textContent = loadingView.title;
            elements.loadingDetail.textContent = loadingView.detail;
            elements.loadingProgressLabel.textContent = loadingView.progressLabel;
            elements.loadingHint.textContent = loadingView.hint;
            elements.loadingProgress.value = loadingView.progress;
            if (!loadingView.preserveContent) {
                this.revokeAssetURLs();
                elements.preview.replaceChildren();
                elements.source.value = '';
            }
            return;
        }

        if (model.status === 'ready') {
            elements.status.textContent = sourceLabel(model.sourceKind, model.cacheHit);
            this.renderMarkdownPreview();
            elements.source.value = model.markdown || '';
            return;
        }

        elements.status.textContent = 'Conversion failed';
    }

    replacePreviewHTML(html) {
        const DOMParserType = this.ownerWindow.DOMParser || globalThis.DOMParser;
        if (!DOMParserType) throw new Error('The Zotero HTML parser is unavailable');
        const parsed = new DOMParserType().parseFromString(
            `<!doctype html><html><body>${html}</body></html>`,
            'text/html'
        );
        if (!parsed.body) throw new Error('The Markdown HTML could not be parsed');
        const nodes = [...parsed.body.childNodes].map(node => (
            this.document.importNode(node, true)
        ));
        this.elements.preview.replaceChildren(...nodes);
    }

    destroy() {
        for (const { element, type, listener } of this.listeners) {
            element.removeEventListener(type, listener);
        }
        this.listeners = [];
        this.revokeAssetURLs();
        this.root.remove?.();
    }

    createStylesheet(rootURI) {
        return this.createElement('link', {
            rel: 'stylesheet',
            href: `${rootURI}ui/markdown.css`,
        });
    }

    createLayoutRoot() {
        if (!this.document.createXULElement) return this.host;
        const root = this.document.createXULElement('vbox');
        root.setAttribute('flex', '1');
        Object.assign(root.style, {
            width: '100%',
            height: '100%',
            minWidth: '0',
            minHeight: '0',
            overflow: 'hidden',
        });
        root.appendChild(this.host);
        return root;
    }

    createContent() {
        const previewButton = this.createModeButton(
            'mktero-show-preview',
            '预览',
            'preview',
            true
        );
        const sourceButton = this.createModeButton(
            'mktero-show-source',
            '查看源文件',
            'source'
        );
        const status = this.createElement(
            'span',
            {
                id: 'mktero-status',
                class: 'visually-hidden',
                role: 'status',
                'aria-live': 'polite',
            },
            'Converting PDF…'
        );

        const modeSwitch = this.createElement('div', {
            class: 'mode-switch',
            role: 'group',
            'aria-label': 'View mode',
        });
        appendChildren(modeSwitch, previewButton, sourceButton);
        const header = this.createElement('header', { class: 'app-header' });
        appendChildren(header, modeSwitch, status);

        const progress = this.createElement('progress', {
            id: 'mktero-progress',
            max: '100',
            value: '0',
        });
        progress.hidden = true;
        const warning = this.createElement('div', {
            id: 'mktero-warning',
            class: 'message warning',
        });
        warning.hidden = true;
        const error = this.createElement('div', {
            id: 'mktero-error',
            class: 'message error',
        });
        error.hidden = true;

        const spinner = this.createElement('div', {
            class: 'loading-spinner',
            'aria-hidden': 'true',
        });
        const loadingEyebrow = this.createElement(
            'span',
            { class: 'loading-eyebrow' },
            'MinerU conversion'
        );
        const loadingTitle = this.createElement(
            'h2',
            { id: 'mktero-loading-title' },
            'Converting PDF…'
        );
        const loadingDetail = this.createElement(
            'p',
            { id: 'mktero-loading-detail' },
            'Preparing the PDF for MinerU.'
        );
        const progressHeadingLabel = this.createElement('span', {}, 'Progress');
        const loadingProgressLabel = this.createElement(
            'strong',
            { id: 'mktero-loading-progress-label' },
            '0%'
        );
        const loadingProgressHeading = this.createElement(
            'div',
            { class: 'loading-progress-heading' }
        );
        appendChildren(
            loadingProgressHeading,
            progressHeadingLabel,
            loadingProgressLabel
        );
        const loadingProgress = this.createElement('progress', {
            id: 'mktero-loading-progress',
            max: '100',
            value: '0',
        });
        const loadingHint = this.createElement(
            'p',
            { id: 'mktero-loading-hint', class: 'loading-hint' },
            'This can take a few minutes. Keep this tab open while MinerU finishes.'
        );
        const loadingContent = this.createElement('div', { class: 'loading-content' });
        appendChildren(
            loadingContent,
            loadingEyebrow,
            loadingTitle,
            loadingDetail,
            loadingProgressHeading,
            loadingProgress,
            loadingHint
        );
        const loading = this.createElement('section', {
            id: 'mktero-loading',
            class: 'loading-state',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        appendChildren(loading, spinner, loadingContent);

        const preview = this.createElement('article', {
            id: 'mktero-preview',
            class: 'markdown-body',
        });
        preview.hidden = true;
        const source = this.createElement('textarea', {
            id: 'mktero-source',
            class: 'markdown-source',
            'aria-label': 'Markdown 源文件',
            autocomplete: 'off',
            spellcheck: 'false',
        });
        source.hidden = true;
        const content = this.createElement('main', {
            id: 'mktero-content',
            'aria-busy': 'true',
        });
        appendChildren(content, loading, preview, source);

        const view = this.createElement('div', { class: 'mktero-tab-view' });
        appendChildren(view, header, progress, warning, error, content);
        return {
            view,
            status,
            progress,
            warning,
            error,
            content,
            loading,
            loadingTitle,
            loadingDetail,
            loadingProgress,
            loadingProgressLabel,
            loadingHint,
            preview,
            source,
            previewButton,
            sourceButton,
        };
    }

    createModeButton(id, label, iconName, active = false) {
        const button = this.createElement('button', {
            id,
            type: 'button',
            'aria-pressed': String(active),
        });
        button.disabled = true;
        button.classList.toggle('active', active);
        appendChildren(
            button,
            this.createModeIcon(iconName),
            this.createElement('span', { class: 'mode-label' }, label)
        );
        return button;
    }

    createModeIcon(iconName) {
        const svg = this.document.createElementNS(SVG_NAMESPACE, 'svg');
        setAttributes(svg, {
            class: 'mode-icon',
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '1.8',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
            'aria-hidden': 'true',
        });
        const iconParts = iconName === 'preview'
            ? [
                ['path', { d: 'M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z' }],
                ['circle', { cx: '12', cy: '12', r: '2.7' }],
            ]
            : [
                ['circle', { cx: '12', cy: '12', r: '9.5' }],
                ['path', { d: 'm9 8-4 4 4 4M15 8l4 4-4 4M14 6.5l-4 11' }],
            ];
        for (const [tagName, attributes] of iconParts) {
            const part = this.document.createElementNS(SVG_NAMESPACE, tagName);
            setAttributes(part, attributes);
            svg.appendChild(part);
        }
        return svg;
    }

    createElement(tagName, attributes = {}, text = '') {
        const element = this.document.createElementNS(XHTML_NAMESPACE, tagName);
        for (const [name, value] of Object.entries(attributes)) {
            element.setAttribute(name, value);
        }
        if (text) element.textContent = text;
        return element;
    }

    bindActions() {
        this.listen(this.elements.previewButton, 'click', () => this.setMode('preview'));
        this.listen(this.elements.sourceButton, 'click', () => this.setMode('source'));
        this.listen(this.elements.source, 'input', () => this.updateMarkdownSource());
        this.listen(this.elements.preview, 'click', event => this.openLink(event));
    }

    listen(element, type, listener) {
        element.addEventListener(type, listener);
        this.listeners.push({ element, type, listener });
    }

    syncContentVisibility(visible) {
        const previewMode = this.elements.previewButton.classList.contains('active');
        this.elements.preview.hidden = !visible || !previewMode;
        this.elements.source.hidden = !visible || previewMode;
        this.elements.content.classList.toggle('source-mode', visible && !previewMode);
    }

    setMode(mode) {
        const previewMode = mode === 'preview';
        const loadingView = createLoadingPresentation(this.model);
        const showContent = this.model.status === 'ready' || loadingView.preserveContent;
        this.elements.previewButton.classList.toggle('active', previewMode);
        this.elements.sourceButton.classList.toggle('active', !previewMode);
        this.elements.previewButton.setAttribute('aria-pressed', String(previewMode));
        this.elements.sourceButton.setAttribute('aria-pressed', String(!previewMode));
        if (previewMode && showContent) this.renderMarkdownPreview();
        this.syncContentVisibility(showContent);
    }

    updateMarkdownSource() {
        this.model.markdown = this.elements.source.value;
    }

    renderMarkdownPreview() {
        this.syncAssetURLs();
        this.replacePreviewHTML(renderMarkdownHTML(this.model.markdown || '', {
            resolveImageURL: source => this.resolveImageURL(source),
        }));
    }

    openLink(event) {
        const anchor = event.target?.closest?.('a[href]');
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute('href') || '';
        if (href.startsWith('#')) {
            this.scrollToFragment(href.slice(1));
            return;
        }
        if (this.zotero?.launchURL) {
            this.zotero.launchURL(href);
        }
    }

    scrollToFragment(fragment) {
        if (!fragment) return;
        let id;
        try {
            id = decodeURIComponent(fragment);
        }
        catch {
            id = fragment;
        }
        this.mount.getElementById?.(id)?.scrollIntoView?.();
    }

    syncAssetURLs() {
        if (this.renderedAssets === this.model.assets) return;
        this.revokeAssetURLs();
        this.renderedAssets = this.model.assets;
        const URLAPI = this.ownerWindow.URL || globalThis.URL;
        const BlobType = this.ownerWindow.Blob || globalThis.Blob;
        for (const asset of this.model.assets || []) {
            if (!asset?.path || !asset?.mimeType || !asset?.data) continue;
            const path = normalizeZipPath(asset.path);
            const url = URLAPI.createObjectURL(new BlobType(
                [asset.data],
                { type: asset.mimeType }
            ));
            this.assetURLs.set(path, url);
        }
    }

    revokeAssetURLs() {
        const URLAPI = this.ownerWindow.URL || globalThis.URL;
        for (const url of this.assetURLs.values()) URLAPI.revokeObjectURL(url);
        this.assetURLs = new Map();
        this.renderedAssets = undefined;
    }

    resolveImageURL(source) {
        const path = String(source || '').split(/[?#]/, 1)[0];
        if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/')) {
            return null;
        }
        let decodedPath;
        try {
            decodedPath = decodeURIComponent(path);
        }
        catch {
            return null;
        }
        return this.assetURLs.get(
            resolveZipPath(this.model.assetBasePath || '', decodedPath)
        ) || null;
    }
}

function appendChildren(parent, ...children) {
    for (const child of children) parent.appendChild(child);
}

function setAttributes(element, attributes) {
    for (const [name, value] of Object.entries(attributes)) {
        element.setAttribute(name, value);
    }
}

function resolveZipPath(basePath, relativePath) {
    const segments = `${basePath}/${relativePath}`.split('/');
    const resolved = [];
    for (const segment of segments) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    return resolved.join('/');
}

function normalizeZipPath(path) {
    return resolveZipPath('', String(path).replace(/\\/g, '/'));
}

function sourceLabel(sourceKind, cacheHit) {
    if (sourceKind === 'markdown' && cacheHit) return 'Cached MinerU Markdown';
    if (sourceKind === 'markdown') return 'MinerU Markdown';
    if (sourceKind === 'structured') return 'Structured Markdown';
    return 'Plain-text Markdown';
}
