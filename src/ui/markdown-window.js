import { renderMarkdownHTML } from '../markdown/markdown-html.js';
import { createLoadingPresentation } from './markdown-loading-state.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

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
        this.copyResetTimer = null;

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

        elements.title.textContent = model.title || 'Mktero';
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
        elements.copyButton.disabled = !showContent;
        elements.reparseButton.disabled = loadingView.visible
            || typeof model.onReparse !== 'function';
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
                elements.source.textContent = '';
            }
            return;
        }

        if (model.status === 'ready') {
            this.syncAssetURLs();
            elements.status.textContent = sourceLabel(model.sourceKind, model.cacheHit);
            this.replacePreviewHTML(renderMarkdownHTML(model.markdown || '', {
                resolveImageURL: source => this.resolveImageURL(source),
            }));
            elements.source.textContent = model.markdown || '';
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
        if (this.copyResetTimer !== null) {
            this.ownerWindow.clearTimeout?.(this.copyResetTimer);
            this.copyResetTimer = null;
        }
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
        const previewButton = this.createButton('mktero-show-preview', 'Preview', true);
        const sourceButton = this.createButton('mktero-show-source', 'Markdown');
        const reparseButton = this.createButton('mktero-reparse', 'Reparse');
        const copyButton = this.createButton('mktero-copy', 'Copy Markdown');
        const title = this.createElement('h1', { id: 'mktero-title' }, 'Mktero');
        const status = this.createElement(
            'span',
            { id: 'mktero-status' },
            'Converting PDF…'
        );
        const titleArea = this.createElement('div', { class: 'title-area' });
        appendChildren(titleArea, title, status);

        const modeSwitch = this.createElement('div', {
            class: 'mode-switch',
            role: 'group',
            'aria-label': 'View mode',
        });
        appendChildren(modeSwitch, previewButton, sourceButton);
        const actions = this.createElement('div', { class: 'actions' });
        appendChildren(actions, modeSwitch, reparseButton, copyButton);
        const header = this.createElement('header', { class: 'app-header' });
        appendChildren(header, titleArea, actions);

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
        const source = this.createElement('pre', {
            id: 'mktero-source',
            class: 'markdown-source',
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
            title,
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
            reparseButton,
            copyButton,
        };
    }

    createButton(id, label, active = false) {
        const button = this.createElement('button', { id, type: 'button' }, label);
        button.disabled = true;
        button.classList.toggle('active', active);
        return button;
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
        this.listen(this.elements.copyButton, 'click', () => this.copyMarkdown());
        this.listen(this.elements.reparseButton, 'click', () => this.reparse());
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
    }

    setMode(mode) {
        const previewMode = mode === 'preview';
        this.elements.preview.hidden = !previewMode;
        this.elements.source.hidden = previewMode;
        this.elements.previewButton.classList.toggle('active', previewMode);
        this.elements.sourceButton.classList.toggle('active', !previewMode);
    }

    async reparse() {
        const button = this.elements.reparseButton;
        if (typeof this.model.onReparse !== 'function') return;
        button.disabled = true;
        try {
            await this.model.onReparse();
        }
        finally {
            button.disabled = this.model.status === 'loading';
        }
    }

    async copyMarkdown() {
        const button = this.elements.copyButton;
        try {
            await this.writeClipboardText(this.model.markdown || '');
            button.textContent = 'Copied';
        }
        catch {
            button.textContent = 'Copy failed';
        }
        if (this.copyResetTimer !== null) {
            this.ownerWindow.clearTimeout?.(this.copyResetTimer);
        }
        this.copyResetTimer = this.ownerWindow.setTimeout?.(() => {
            button.textContent = 'Copy Markdown';
            this.copyResetTimer = null;
        }, 1500) ?? null;
    }

    async writeClipboardText(text) {
        const clipboard = this.ownerWindow.navigator?.clipboard;
        if (clipboard?.writeText) {
            try {
                await clipboard.writeText(text);
                return;
            }
            catch {
                // Privileged Zotero windows can reject the web Clipboard API.
            }
        }
        const copyText = this.zotero?.Utilities?.Internal?.copyTextToClipboard;
        if (!copyText) throw new Error('Clipboard API unavailable');
        copyText.call(this.zotero.Utilities.Internal, text);
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
