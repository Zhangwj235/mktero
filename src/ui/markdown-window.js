import { createInlineMarkdownEditor } from '../editor/inline-markdown-editor.js';
import { extractMarkdownOutline } from '../markdown/markdown-outline.js';
import {
    bindEditorToolbar,
    createEditorToolbar,
    createToolbarButton,
} from './editor-toolbar.js';
import { createLoadingPresentation } from './markdown-loading-state.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const BUNDLED_MARKDOWN_STYLES = typeof __MKTERO_MARKDOWN_STYLES__ === 'string'
    ? __MKTERO_MARKDOWN_STYLES__
    : null;
const OUTLINE_ICON = [
    ['rect', { x: '2.5', y: '3', width: '15', height: '14', rx: '1.5' }],
    ['path', { d: 'M7.5 3v14M4.5 7h.01M4.5 10h.01M4.5 13h.01' }],
];

export function createMarkdownTabView({
    document,
    model,
    zotero,
    stylesheetText = BUNDLED_MARKDOWN_STYLES,
    editorFactory = createInlineMarkdownEditor,
}) {
    return new MarkdownTabView({
        document,
        model,
        zotero,
        stylesheetText,
        editorFactory,
    });
}

class MarkdownTabView {
    constructor({ document, model, zotero, stylesheetText, editorFactory }) {
        if (!document?.createElementNS) {
            throw new Error('The Zotero window cannot create the Markdown view');
        }
        if (!stylesheetText) {
            throw new Error('The bundled Markdown styles are unavailable');
        }

        this.document = document;
        this.ownerWindow = document.defaultView || globalThis;
        this.zotero = zotero;
        this.model = model;
        this.renderedAssets = undefined;
        this.assetURLs = new Map();
        this.listeners = [];
        this.draftMarkdown = '';
        this.savedMarkdown = '';
        this.saving = false;
        this.saveState = 'unavailable';
        this.outlineVisible = true;

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
        this.mount.appendChild(this.createStylesheet(stylesheetText));
        this.elements = this.createContent();
        this.mount.appendChild(this.elements.view);
        this.editor = editorFactory({
            document: this.document,
            parent: this.elements.editorHost,
            initialMarkdown: '',
            resolveImageURL: source => this.resolveImageURL(source),
            openLink: href => this.openLink(href),
            onChange: markdown => this.updateMarkdownSource(markdown),
            onSaveRequest: markdown => {
                this.updateMarkdownSource(markdown);
                this.saveMarkdownSource();
            },
        });
        this.syncOutline('');
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
        this.syncContentVisibility(showContent);

        if (loadingView.visible) {
            elements.loadingTitle.textContent = loadingView.title;
            elements.loadingDetail.textContent = loadingView.detail;
            elements.loadingProgressLabel.textContent = loadingView.progressLabel;
            elements.loadingHint.textContent = loadingView.hint;
            elements.loadingProgress.value = loadingView.progress;
            if (!loadingView.preserveContent) {
                this.revokeAssetURLs();
                this.editor.setMarkdown('');
                this.syncOutline('');
            }
            return;
        }

        if (model.status === 'ready') {
            this.draftMarkdown = model.markdown || '';
            this.savedMarkdown = this.draftMarkdown;
            const assetsChanged = this.syncAssetURLs();
            this.editor.setMarkdown(this.draftMarkdown);
            this.syncOutline(this.draftMarkdown);
            if (assetsChanged) this.editor.refreshRendering();
            this.setSaveState(
                this.canSave() ? 'clean' : 'unavailable'
            );
            return;
        }

    }

    destroy() {
        for (const { element, type, listener } of this.listeners) {
            element.removeEventListener(type, listener);
        }
        this.listeners = [];
        this.editor?.destroy();
        this.revokeAssetURLs();
        this.root.remove?.();
    }

    createStylesheet(stylesheetText) {
        const style = this.createElement('style', {
            'data-mktero-styles': 'embedded',
        });
        style.textContent = stylesheetText;
        return style;
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
        const initialLoading = createLoadingPresentation({
            status: 'loading',
            progress: 0,
            preserveContent: false,
        });
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
        const saveError = this.createElement('div', {
            id: 'mktero-save-error',
            class: 'message error',
            role: 'alert',
        });
        saveError.hidden = true;

        const spinner = this.createElement('div', {
            class: 'loading-spinner',
            'aria-hidden': 'true',
        });
        const loadingTitle = this.createElement(
            'h2',
            { id: 'mktero-loading-title' },
            initialLoading.title
        );
        const loadingDetail = this.createElement(
            'p',
            { id: 'mktero-loading-detail' },
            initialLoading.detail
        );
        const progressHeadingLabel = this.createElement('span', {}, 'Progress');
        const loadingProgressLabel = this.createElement(
            'strong',
            { id: 'mktero-loading-progress-label' },
            initialLoading.progressLabel
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
            initialLoading.hint
        );
        const loadingContent = this.createElement('div', { class: 'loading-content' });
        appendChildren(
            loadingContent,
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

        const saveButton = this.createElement(
            'button',
            {
                id: 'mktero-save',
                class: 'save-button',
                type: 'button',
                title: '保存 Markdown（⌘/Ctrl + S）',
            },
            '保存'
        );
        saveButton.disabled = true;
        const sourceActions = this.createElement('div', { class: 'source-actions' });
        sourceActions.appendChild(saveButton);
        const outlineToggleButton = createToolbarButton(this.document, {
            id: 'mktero-toggle-outline',
            label: '隐藏目录',
            icon: OUTLINE_ICON,
            pressed: true,
        });
        outlineToggleButton.disabled = true;
        outlineToggleButton.setAttribute('aria-controls', 'mktero-outline');
        const outlineToolbarGroup = this.createElement('div', {
            class: 'editor-toolbar-group editor-toolbar-view-group',
            role: 'group',
            'aria-label': '视图',
        });
        outlineToolbarGroup.appendChild(outlineToggleButton);
        const { editorToolbar, toolbarButtons } = createEditorToolbar(this.document);
        editorToolbar.insertBefore(outlineToolbarGroup, editorToolbar.firstChild);
        const header = this.createElement('header', { class: 'app-header' });
        appendChildren(header, editorToolbar, sourceActions);

        const editorHost = this.createElement('div', {
            id: 'mktero-editor',
            class: 'markdown-editor-host',
        });
        const editorSection = this.createElement('section', {
            class: 'markdown-editor',
            'aria-label': 'Markdown 所见即所得编辑器',
        });
        editorSection.appendChild(editorHost);
        const outlineTitle = this.createElement(
            'h2',
            { class: 'markdown-outline-title' },
            '目录'
        );
        const outlineList = this.createElement('ol', {
            class: 'markdown-outline-list',
        });
        const outline = this.createElement('aside', {
            id: 'mktero-outline',
            class: 'markdown-outline',
            'aria-label': 'Markdown 目录',
        });
        appendChildren(outline, outlineTitle, outlineList);
        const workspace = this.createElement('div', { class: 'markdown-workspace' });
        workspace.hidden = true;
        appendChildren(workspace, outline, editorSection);
        const content = this.createElement('main', {
            id: 'mktero-content',
            'aria-busy': 'true',
        });
        appendChildren(content, loading, workspace);

        const view = this.createElement('div', { class: 'mktero-tab-view' });
        appendChildren(view, header, progress, warning, error, saveError, content);
        return {
            view,
            progress,
            warning,
            error,
            saveError,
            content,
            loading,
            loadingTitle,
            loadingDetail,
            loadingProgress,
            loadingProgressLabel,
            loadingHint,
            workspace,
            outline,
            outlineList,
            editorHost,
            editorSection,
            saveButton,
            editorToolbar,
            toolbarButtons,
            outlineToggleButton,
        };
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
        this.listen(this.elements.saveButton, 'click', () => this.saveMarkdownSource());
        this.listen(
            this.elements.outlineToggleButton,
            'mousedown',
            event => event.preventDefault()
        );
        this.listen(this.elements.outlineToggleButton, 'click', () => {
            this.setOutlineVisibility(!this.outlineVisible);
        });
        this.listen(this.elements.outlineList, 'click', event => {
            const button = event.target?.closest?.('.markdown-outline-link');
            if (!button || !this.elements.outlineList.contains(button)) return;
            const offset = Number(button.getAttribute('data-offset'));
            if (Number.isFinite(offset)) this.editor.scrollToOffset?.(offset);
        });
        bindEditorToolbar({
            toolbarButtons: this.elements.toolbarButtons,
            runCommand: command => this.editor.runCommand(command),
            listen: (element, type, listener) => this.listen(
                element,
                type,
                listener
            ),
        });
    }

    listen(element, type, listener) {
        element.addEventListener(type, listener);
        this.listeners.push({ element, type, listener });
    }

    syncContentVisibility(visible) {
        this.elements.workspace.hidden = !visible;
        this.elements.outlineToggleButton.disabled = !visible;
        for (const { button } of this.elements.toolbarButtons) {
            button.disabled = !visible;
        }
    }

    setOutlineVisibility(visible) {
        this.outlineVisible = visible;
        this.elements.outline.hidden = !visible;
        const label = visible ? '隐藏目录' : '显示目录';
        this.elements.outlineToggleButton.setAttribute(
            'aria-pressed',
            String(visible)
        );
        this.elements.outlineToggleButton.setAttribute('aria-label', label);
        this.elements.outlineToggleButton.setAttribute('title', label);
    }

    updateMarkdownSource(markdown) {
        this.draftMarkdown = markdown;
        this.syncOutline(markdown);
        if (!this.canSave()) {
            this.setSaveState('unavailable');
            return;
        }
        if (this.saving) {
            this.setSaveState('saving');
            return;
        }
        this.setSaveState(
            this.draftMarkdown === this.savedMarkdown ? 'clean' : 'dirty'
        );
    }

    syncOutline(markdown) {
        const list = this.elements.outlineList;
        list.replaceChildren();
        const headings = extractMarkdownOutline(markdown);
        if (!headings.length) {
            list.appendChild(this.createElement(
                'li',
                { class: 'markdown-outline-empty' },
                '暂无目录'
            ));
            return;
        }
        for (const heading of headings) {
            const button = this.createElement(
                'button',
                {
                    class: 'markdown-outline-link',
                    type: 'button',
                    'data-level': String(heading.level),
                    'data-offset': String(heading.offset),
                    style: `--outline-indent: ${(heading.level - 1) * 12}px;`,
                    title: heading.text,
                },
                heading.text
            );
            const item = this.createElement('li', {
                class: 'markdown-outline-item',
            });
            item.appendChild(button);
            list.appendChild(item);
        }
    }

    async saveMarkdownSource() {
        if (this.saving || this.draftMarkdown === this.savedMarkdown) return;
        if (!this.canSave()) {
            this.setSaveState('unavailable');
            return;
        }

        const markdown = this.draftMarkdown;
        this.saving = true;
        this.setSaveState('saving');
        try {
            await this.model.onSave(markdown, this.model);
            this.savedMarkdown = markdown;
            this.model.markdown = markdown;
            this.setSaveState(
                this.draftMarkdown === this.savedMarkdown ? 'saved' : 'dirty'
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setSaveState('error', message || '未知错误');
        }
        finally {
            this.saving = false;
            if (this.draftMarkdown !== this.savedMarkdown
                && this.saveState === 'saving') {
                this.setSaveState('dirty');
            }
        }
    }

    setSaveState(state, detail = '') {
        const errorMessage = detail ? `保存失败：${detail}` : '保存失败';
        const titles = {
            clean: '保存 Markdown（⌘/Ctrl + S）',
            dirty: '保存 Markdown（⌘/Ctrl + S）',
            saving: '正在保存 Markdown…',
            saved: '保存 Markdown（⌘/Ctrl + S）',
            unavailable: '当前内容无法保存到本地缓存',
            error: `${errorMessage}。点击重试`,
        };
        this.saveState = state;
        this.elements.saveError.hidden = state !== 'error';
        this.elements.saveError.textContent = state === 'error' ? errorMessage : '';
        this.elements.saveButton.setAttribute('data-state', state);
        this.elements.saveButton.setAttribute('title', titles[state] || titles.clean);
        this.elements.saveButton.setAttribute('aria-label', titles[state] || titles.clean);
        this.elements.saveButton.disabled = state === 'clean'
            || state === 'saved'
            || state === 'saving'
            || state === 'unavailable';
    }

    canSave() {
        return Boolean(this.model.onSave && this.model.cacheKey);
    }

    openLink(href) {
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
        if (this.renderedAssets === this.model.assets) return false;
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
        return true;
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
