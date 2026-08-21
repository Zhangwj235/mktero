import {
    forceCenter,
    forceCollide,
    forceLink,
    forceManyBody,
    forceSimulation,
} from 'd3-force';
import { createLocalization } from '../i18n/localization.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const BUNDLED_CITATION_GRAPH_STYLES
    = typeof __MKTERO_CITATION_GRAPH_STYLES__ === 'string'
        ? __MKTERO_CITATION_GRAPH_STYLES__
        : null;
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const SEARCH_LIMIT = 20;

export function createCitationGraphView({
    document,
    stylesheetText = BUNDLED_CITATION_GRAPH_STYLES,
    localization = createLocalization(),
    onRefresh = null,
    onOpenPaper = null,
    onError = null,
    createSimulation = createDefaultSimulation,
    createResizeObserver = null,
    requestAnimationFrame = null,
    cancelAnimationFrame = null,
    measure = null,
} = {}) {
    return new CitationGraphView({
        document,
        stylesheetText,
        localization,
        onRefresh,
        onOpenPaper,
        onError,
        createSimulation,
        createResizeObserver,
        requestAnimationFrame,
        cancelAnimationFrame,
        measure,
    });
}

class CitationGraphView {
    constructor({
        document,
        stylesheetText,
        localization,
        onRefresh,
        onOpenPaper,
        onError,
        createSimulation,
        createResizeObserver,
        requestAnimationFrame,
        cancelAnimationFrame,
        measure,
    }) {
        if (!document?.createElementNS) {
            throw new Error(localization.t('error.citationGraphViewUnavailable'));
        }
        if (!stylesheetText) {
            throw new Error(localization.t('error.citationGraphStylesUnavailable'));
        }
        this.document = document;
        this.ownerWindow = document.defaultView || globalThis;
        this.localization = localization;
        this.t = localization.t.bind(localization);
        this.onRefresh = onRefresh;
        this.onOpenPaper = onOpenPaper;
        this.onError = onError;
        this.createSimulation = createSimulation;
        this.measure = measure || (() => this.measureCanvas());
        this.requestFrame = requestAnimationFrame
            || this.ownerWindow.requestAnimationFrame?.bind(this.ownerWindow)
            || (callback => this.ownerWindow.setTimeout(callback, 16));
        this.cancelFrame = cancelAnimationFrame
            || this.ownerWindow.cancelAnimationFrame?.bind(this.ownerWindow)
            || (id => this.ownerWindow.clearTimeout(id));
        this.nodes = [];
        this.edges = [];
        this.nodeByID = new Map();
        this.snapshot = null;
        this.selectedItemID = null;
        this.filter = 'all';
        this.transform = { x: 0, y: 0, scale: 1 };
        this.frameID = null;
        this.simulation = null;
        this.destroyed = false;
        this.pointer = null;
        this.listeners = [];
        this.navigationError = '';
        this.keepFocusedNodeCentered = false;
        this.motionQuery = this.ownerWindow.matchMedia?.(
            '(prefers-reduced-motion: reduce)'
        ) || null;

        this.root = this.element('div', 'citation-graph-host');
        if (!this.root.attachShadow) {
            throw new Error(this.message('error.citationGraphViewUnavailable'));
        }
        this.mount = this.root.attachShadow({ mode: 'open' });
        this.mount.appendChild(this.element('style', '', stylesheetText));
        this.buildInterface();
        this.bindControls();
        this.resizeObserver = this.createObserver(createResizeObserver);
        this.resizeObserver?.observe?.(this.root);
        this.resizeCanvas();
    }

    resize() {
        if (this.destroyed) return;
        const previousWidth = this.cssWidth;
        const previousHeight = this.cssHeight;
        this.resizeCanvas();
        if (this.nodes.length
            && (this.cssWidth !== previousWidth
                || this.cssHeight !== previousHeight)) {
            this.keepFocusedNodeCentered = Boolean(this.selectedNode());
            this.startSimulation();
            this.centerNode(this.selectedNode());
        }
        this.scheduleDraw();
    }

    buildInterface() {
        const shell = this.element('div', 'citation-graph-shell');
        const toolbar = this.element('header', 'citation-graph-toolbar');
        const identity = this.element('div', 'citation-graph-identity');
        this.libraryName = this.element('h1', 'citation-graph-title');
        this.counts = this.element('div', 'citation-graph-counts');
        identity.append(this.libraryName, this.counts);

        const searchWrap = this.element('div', 'citation-graph-search-wrap');
        this.search = this.element('input', 'citation-graph-search');
        this.search.type = 'search';
        this.search.autocomplete = 'off';
        this.search.placeholder = this.message('graph.searchPlaceholder');
        this.search.setAttribute(
            'aria-label',
            this.message('graph.search')
        );
        this.searchResults = this.element(
            'div',
            'citation-graph-search-results'
        );
        this.searchResults.setAttribute('role', 'listbox');
        searchWrap.append(this.search, this.searchResults);

        const filters = this.element('div', 'citation-graph-filters');
        filters.setAttribute('role', 'group');
        filters.setAttribute(
            'aria-label',
            this.message('graph.filter')
        );
        this.allFilter = this.textButton(
            this.message('graph.filterAll'),
            'citation-graph-filter'
        );
        this.allFilter.dataset.filter = 'all';
        this.connectedFilter = this.textButton(
            this.message('graph.filterConnected'),
            'citation-graph-filter'
        );
        this.connectedFilter.dataset.filter = 'connected';
        this.visibleCount = this.element(
            'span',
            'citation-graph-visible-count sr-only'
        );
        this.visibleCount.setAttribute('aria-live', 'polite');
        filters.append(this.allFilter, this.connectedFilter, this.visibleCount);

        const actions = this.element('div', 'citation-graph-actions');
        this.refreshButton = this.iconButton(
            'refresh',
            LUCIDE_ICONS.refreshCw,
            this.message('graph.refresh')
        );
        this.zoomOutButton = this.iconButton(
            'zoom-out',
            LUCIDE_ICONS.zoomOut,
            this.message('graph.zoomOut')
        );
        this.zoomInButton = this.iconButton(
            'zoom-in',
            LUCIDE_ICONS.zoomIn,
            this.message('graph.zoomIn')
        );
        this.resetButton = this.iconButton(
            'reset',
            LUCIDE_ICONS.rotateCcw,
            this.message('graph.resetView')
        );
        actions.append(
            this.refreshButton,
            this.zoomOutButton,
            this.zoomInButton,
            this.resetButton
        );
        toolbar.append(identity, searchWrap, filters, actions);

        const content = this.element('div', 'citation-graph-content');
        this.canvasWrap = this.element('div', 'citation-graph-canvas-wrap');
        this.canvas = this.element('canvas', 'citation-graph-canvas');
        this.canvas.setAttribute('aria-hidden', 'true');
        this.emptyState = this.element('div', 'citation-graph-empty');
        this.emptyState.hidden = true;
        this.status = this.element('div', 'citation-graph-status');
        this.status.setAttribute('role', 'status');
        this.status.setAttribute('aria-live', 'polite');
        this.hoverDetails = this.element('div', 'citation-graph-hover');
        this.hoverDetails.hidden = true;
        this.hoverDetails.setAttribute('role', 'tooltip');
        this.hoverTitle = this.element('strong', 'citation-graph-hover-title');
        this.hoverMeta = this.element('span', 'citation-graph-hover-meta');
        this.hoverDetails.append(this.hoverTitle, this.hoverMeta);
        this.canvasWrap.append(
            this.canvas,
            this.emptyState,
            this.status,
            this.hoverDetails
        );
        this.details = this.element('aside', 'citation-graph-details');
        this.details.setAttribute(
            'aria-label',
            this.message('graph.details')
        );
        content.append(this.canvasWrap, this.details);
        shell.append(toolbar, content);
        this.mount.appendChild(shell);
        this.context = this.canvas.getContext?.('2d') || null;
    }

    bindControls() {
        this.listen(this.search, 'input', () => this.renderSearchResults());
        this.listen(this.searchResults, 'click', event => {
            const button = event.target?.closest?.('button[data-item-id]');
            const node = this.nodeForControl(button);
            if (!node) return;
            this.focus(node.itemID);
            this.searchResults.hidden = true;
        });
        this.listen(this.details, 'click', event => {
            const button = event.target?.closest?.('button');
            if (!button) return;
            if (button.dataset.action === 'open-paper') {
                this.openPaper(this.selectedNode());
                return;
            }
            const node = this.nodeForControl(button);
            if (node) this.focus(node.itemID);
        });
        this.listen(this.details, 'dblclick', event => {
            const button = event.target?.closest?.('button[data-item-id]');
            const node = this.nodeForControl(button);
            if (node) this.openPaper(node);
        });
        this.listen(this.allFilter, 'click', () => this.setFilter('all'));
        this.listen(
            this.connectedFilter,
            'click',
            () => this.setFilter('connected')
        );
        this.listen(this.refreshButton, 'click', () => this.onRefresh?.());
        this.listen(this.zoomOutButton, 'click', () => this.zoomBy(0.8));
        this.listen(this.zoomInButton, 'click', () => this.zoomBy(1.25));
        this.listen(this.resetButton, 'click', () => this.resetView());
        this.listen(this.canvas, 'wheel', event => this.handleWheel(event));
        this.listen(
            this.canvas,
            'pointerdown',
            event => this.handlePointerDown(event)
        );
        this.listen(
            this.canvas,
            'pointermove',
            event => this.handlePointerMove(event)
        );
        this.listen(
            this.canvas,
            'pointerup',
            event => this.handlePointerUp(event)
        );
        this.listen(
            this.canvas,
            'pointercancel',
            event => this.handlePointerUp(event)
        );
        this.listen(this.canvas, 'pointerleave', () => this.hideHoverDetails());
        this.listen(this.canvas, 'dblclick', event => {
            const node = this.hitTest(event);
            if (node) this.openPaper(node);
        });
        if (this.motionQuery?.addEventListener) {
            this.listen(this.motionQuery, 'change', () => this.startSimulation());
        }
    }

    render(snapshot) {
        if (this.destroyed || !snapshot) return;
        const hadSnapshot = Boolean(this.snapshot);
        const previousRequestedSelection = this.snapshot?.selectedItemID;
        const previousNodes = new Map(this.nodes.map(node => [node.id, node]));
        this.snapshot = snapshot;
        this.nodes = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).map(
            (node, index) => {
                const previous = previousNodes.get(node.id);
                return {
                    ...node,
                    x: finite(previous?.x, 120 + (index % 8) * 90),
                    y: finite(previous?.y, 120 + Math.floor(index / 8) * 70),
                    vx: finite(previous?.vx, 0),
                    vy: finite(previous?.vy, 0),
                };
            }
        );
        this.nodeByID = new Map(this.nodes.map(node => [node.id, node]));
        this.edges = normalizeEdges(snapshot.edges, this.nodeByID);
        this.libraryName.textContent = snapshot.libraryName
            || this.message('graph.title');
        this.counts.textContent = `${this.countMessage(
            'paper',
            this.nodes.length
        )} · ${this.countMessage('citation', this.edges.length)}`;
        this.renderStatus();
        this.updateFilterControls();
        this.renderSearchResults();
        this.startSimulation();

        const selectedStillExists = this.nodes.some(node => sameItemID(
            node.itemID,
            this.selectedItemID
        ));
        const requestedSelection = snapshot.selectedItemID;
        const hasRequestedSelection = requestedSelection !== null
            && requestedSelection !== undefined;
        const requestedSelectionChanged = hasRequestedSelection && (
            !hadSnapshot
            || !sameItemID(requestedSelection, previousRequestedSelection)
        );
        if (hasRequestedSelection
            && (!selectedStillExists || requestedSelectionChanged)) {
            this.focus(requestedSelection, { center: true });
        }
        else if (!selectedStillExists) {
            this.selectedItemID = this.nodes[0]?.itemID ?? null;
            this.renderDetails();
        }
        else {
            this.renderDetails();
        }
        this.scheduleDraw();
    }

    focus(itemID, { center = true } = {}) {
        if (this.destroyed) return false;
        const node = this.nodes.find(candidate => sameItemID(
            candidate.itemID,
            itemID
        ));
        if (!node) return false;
        this.selectedItemID = node.itemID;
        if (center) {
            this.keepFocusedNodeCentered = true;
            this.centerNode(node);
        }
        this.renderDetails();
        this.scheduleDraw();
        return true;
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.frameID !== null) {
            this.cancelFrame(this.frameID);
            this.frameID = null;
        }
        this.simulation?.stop?.();
        this.simulation = null;
        this.resizeObserver?.disconnect?.();
        this.resizeObserver = null;
        for (const dispose of this.listeners.splice(0)) dispose();
        this.mount.replaceChildren();
        this.nodes = [];
        this.edges = [];
        this.nodeByID.clear();
    }

    startSimulation() {
        this.simulation?.stop?.();
        this.simulation = this.createSimulation(this.nodes, this.edges, {
            width: this.cssWidth || DEFAULT_WIDTH,
            height: this.cssHeight || DEFAULT_HEIGHT,
        });
        if (this.prefersReducedMotion()) {
            this.simulation?.stop?.();
            this.simulation?.tick?.(240);
            this.centerNode(this.selectedNode());
            this.keepFocusedNodeCentered = false;
            this.scheduleDraw();
            return;
        }
        this.simulation?.on?.('tick', () => {
            if (this.keepFocusedNodeCentered) {
                this.centerNode(this.selectedNode());
            }
            this.scheduleDraw();
        });
        this.simulation?.on?.('end', () => {
            if (this.destroyed) return;
            if (this.keepFocusedNodeCentered) {
                this.centerNode(this.selectedNode());
                this.keepFocusedNodeCentered = false;
            }
            this.scheduleDraw();
        });
    }

    createObserver(factory) {
        if (typeof factory === 'function') {
            return factory(() => this.resize());
        }
        const Observer = this.ownerWindow.ResizeObserver
            || globalThis.ResizeObserver;
        return typeof Observer === 'function'
            ? new Observer(() => this.resize())
            : null;
    }

    resizeCanvas() {
        if (this.destroyed) return;
        const measured = this.measure() || {};
        const width = Math.max(1, finite(measured.width, DEFAULT_WIDTH));
        const height = Math.max(1, finite(measured.height, DEFAULT_HEIGHT));
        const ratio = Math.max(1, finite(this.ownerWindow.devicePixelRatio, 1));
        this.cssWidth = width;
        this.cssHeight = height;
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        this.canvas.width = Math.round(width * ratio);
        this.canvas.height = Math.round(height * ratio);
        this.pixelRatio = ratio;
        this.scheduleDraw();
    }

    measureCanvas() {
        const bounds = this.canvasWrap.getBoundingClientRect?.();
        return {
            width: bounds?.width || this.canvasWrap.clientWidth || DEFAULT_WIDTH,
            height: bounds?.height || this.canvasWrap.clientHeight || DEFAULT_HEIGHT,
        };
    }

    scheduleDraw() {
        if (this.destroyed || this.frameID !== null) return;
        this.frameID = this.requestFrame(() => {
            this.frameID = null;
            this.draw();
        });
    }

    draw() {
        const context = this.context;
        if (!context || this.destroyed) return;
        const ratio = this.pixelRatio || 1;
        context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
        context.clearRect?.(0, 0, this.cssWidth, this.cssHeight);
        const visibleIDs = new Set(this.visibleNodes().map(node => node.id));
        context.save?.();
        context.translate?.(this.transform.x, this.transform.y);
        context.scale?.(this.transform.scale, this.transform.scale);
        this.drawEdges(context, visibleIDs);
        this.drawNodes(context, visibleIDs);
        context.restore?.();
    }

    drawEdges(context, visibleIDs) {
        context.strokeStyle = 'rgba(96, 104, 116, 0.5)';
        context.fillStyle = 'rgba(96, 104, 116, 0.72)';
        context.lineWidth = 1 / this.transform.scale;
        for (const edge of this.edges) {
            if (!visibleIDs.has(edge.source.id) || !visibleIDs.has(edge.target.id)) {
                continue;
            }
            const angle = Math.atan2(
                edge.target.y - edge.source.y,
                edge.target.x - edge.source.x
            );
            const targetRadius = nodeRadius(edge.target);
            const endX = edge.target.x - Math.cos(angle) * targetRadius;
            const endY = edge.target.y - Math.sin(angle) * targetRadius;
            context.beginPath?.();
            context.moveTo?.(edge.source.x, edge.source.y);
            context.lineTo?.(endX, endY);
            context.stroke?.();
            const arrowSize = 5 / Math.sqrt(this.transform.scale);
            context.beginPath?.();
            context.moveTo?.(endX, endY);
            context.lineTo?.(
                endX - Math.cos(angle - Math.PI / 6) * arrowSize,
                endY - Math.sin(angle - Math.PI / 6) * arrowSize
            );
            context.lineTo?.(
                endX - Math.cos(angle + Math.PI / 6) * arrowSize,
                endY - Math.sin(angle + Math.PI / 6) * arrowSize
            );
            context.closePath?.();
            context.fill?.();
        }
    }

    drawNodes(context, visibleIDs) {
        const selected = this.selectedNode();
        const labelColor = this.canvasTextColor();
        for (const node of this.nodes) {
            if (!visibleIDs.has(node.id)) continue;
            const isSelected = selected?.id === node.id;
            context.beginPath?.();
            context.arc?.(node.x, node.y, nodeRadius(node), 0, Math.PI * 2);
            context.fillStyle = isSelected
                ? '#b45309'
                : node.degree > 0 ? '#2f6f9f' : '#6b7280';
            context.fill?.();
            context.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,.8)';
            context.lineWidth = (isSelected ? 2 : 1) / this.transform.scale;
            context.stroke?.();
            if (this.transform.scale < 0.58 && !isSelected) continue;
            context.fillStyle = labelColor;
            context.font = `${12 / this.transform.scale}px system-ui, sans-serif`;
            context.textBaseline = 'middle';
            context.fillText?.(
                truncateLabel(node.title || this.message('graph.untitled')),
                node.x + nodeRadius(node) + 5 / this.transform.scale,
                node.y
            );
        }
    }

    renderStatus() {
        const { status = 'complete', progress = {} } = this.snapshot || {};
        this.refreshButton.disabled = status === 'refreshing';
        const warnings = Array.isArray(this.snapshot?.warnings)
            ? this.snapshot.warnings
            : [];
        const messages = [];
        const pendingRateLimit = warnings.find(warning => (
            warning?.code === 'rate-limited' && warning.pending
        ));
        if (this.navigationError) {
            messages.push(this.navigationError);
        }
        else if (status === 'loading') {
            messages.push(this.message('graph.loadingCache'));
        }
        else if (status === 'refreshing' && pendingRateLimit) {
            messages.push(this.message('graph.rateLimitedRetry', {
                seconds: Math.max(
                    1,
                    Math.ceil((pendingRateLimit.retryAfterMs || 0) / 1_000)
                ),
            }));
        }
        else if (status === 'refreshing') {
            const key = warnings.some(warning => warning?.code === 'stale-cache')
                ? 'graph.refreshingCached'
                : 'graph.refreshing';
            messages.push(this.message(key, {
                completed: progress.completed || 0,
                total: progress.total || 0,
            }));
        }
        else if (status === 'partial') {
            messages.push(this.message('graph.partialCached'));
        }
        else if (status === 'error') {
            messages.push(this.snapshot?.error || this.message('graph.loadFailed'));
        }
        else if (status === 'cancelled') {
            messages.push(this.message('graph.cancelled'));
        }
        else if (this.nodes.length && this.nodes.every(node => (
            !node.doi && !node.arxivID
        ))) {
            messages.push(this.message('graph.noIdentifiers'));
        }
        else if (this.nodes.length && !this.edges.length) {
            messages.push(this.message('graph.noEdges'));
        }
        this.appendWarningStatus(messages, warnings);
        this.status.textContent = messages.join(' · ');
        this.emptyState.hidden = status === 'loading' || this.nodes.length > 0;
        this.emptyState.textContent = this.message('graph.empty');
    }

    appendWarningStatus(messages, warnings) {
        const unresolved = warningCount(warnings, 'unresolved-papers');
        const truncated = warningCount(warnings, 'references-truncated');
        const missing = warningCount(warnings, 'missing-identifiers');
        const ambiguous = warningCount(warnings, 'ambiguous-identifier');
        if (unresolved) {
            messages.push(this.message('graph.unresolvedWarning', {
                count: unresolved,
            }));
        }
        if (truncated) {
            messages.push(this.message('graph.truncatedWarning', {
                count: truncated,
            }));
        }
        if (missing && !messages.includes(this.message('graph.noIdentifiers'))) {
            messages.push(this.message('graph.missingIdentifiersWarning', {
                count: missing,
            }));
        }
        if (ambiguous) {
            messages.push(this.message('graph.ambiguousWarning', {
                count: ambiguous,
            }));
        }
    }

    renderSearchResults() {
        if (!this.searchResults) return;
        this.searchResults.replaceChildren();
        const query = String(this.search.value || '').trim().toLocaleLowerCase();
        if (!query) {
            this.searchResults.hidden = true;
            return;
        }
        const matches = this.visibleNodes().filter(node => (
            String(node.title || '').toLocaleLowerCase().includes(query)
            || String(node.doi || '').toLocaleLowerCase().includes(query)
            || String(node.arxivID || '').toLocaleLowerCase().includes(query)
        )).slice(0, SEARCH_LIMIT);
        for (const node of matches) {
            const button = this.textButton(
                node.title || this.message('graph.untitled'),
                'citation-graph-search-result'
            );
            button.setAttribute('role', 'option');
            button.dataset.itemId = String(node.itemID);
            this.searchResults.appendChild(button);
        }
        if (!matches.length) {
            this.searchResults.appendChild(this.element(
                'div',
                'citation-graph-search-empty',
                this.message('graph.noSearchResults')
            ));
        }
        this.searchResults.hidden = false;
    }

    renderDetails() {
        if (!this.details) return;
        this.details.replaceChildren();
        const node = this.selectedNode();
        if (!node) {
            this.details.appendChild(this.element(
                'p',
                'citation-graph-details-empty',
                this.message('graph.selectPaper')
            ));
            return;
        }
        const heading = this.element(
            'h2',
            'citation-graph-paper-title',
            node.title || this.message('graph.untitled')
        );
        const metadata = this.element('dl', 'citation-graph-metadata');
        this.appendMetadata(metadata, this.message('graph.year'), node.year);
        this.appendMetadata(metadata, 'DOI', node.doi);
        this.appendMetadata(metadata, 'arXiv', node.arxivID);
        this.appendMetadata(
            metadata,
            this.message('graph.referencesCount'),
            node.outDegree
        );
        this.appendMetadata(
            metadata,
            this.message('graph.citedByCount'),
            node.inDegree
        );
        const open = this.textButton(
            this.message('graph.openWithMktero'),
            'citation-graph-open-paper'
        );
        open.dataset.action = 'open-paper';
        open.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.externalLink,
            { size: 15 }
        ));
        const references = this.relationshipSection(
            this.message('graph.references'),
            'references',
            this.edges
                .filter(edge => edge.source.id === node.id)
                .map(edge => edge.target)
        );
        const citedBy = this.relationshipSection(
            this.message('graph.citedBy'),
            'cited-by',
            this.edges
                .filter(edge => edge.target.id === node.id)
                .map(edge => edge.source)
        );
        this.details.append(heading, metadata, open, references, citedBy);
    }

    relationshipSection(title, relation, nodes) {
        const section = this.element('section', 'citation-graph-relations');
        section.dataset.relation = relation;
        section.appendChild(this.element('h3', '', `${title} (${nodes.length})`));
        const list = this.element('ul', 'citation-graph-relation-list');
        for (const node of nodes) {
            const item = this.element('li');
            const button = this.textButton(
                node.title || this.message('graph.untitled'),
                'citation-graph-relation-button'
            );
            button.dataset.itemId = String(node.itemID);
            item.appendChild(button);
            list.appendChild(item);
        }
        if (!nodes.length) {
            list.appendChild(this.element(
                'li',
                'citation-graph-relation-empty',
                this.message('graph.noRelations')
            ));
        }
        section.appendChild(list);
        return section;
    }

    appendMetadata(list, label, value) {
        if (value === null || value === undefined || value === '') return;
        list.append(
            this.element('dt', '', label),
            this.element('dd', '', String(value))
        );
    }

    setFilter(filter) {
        this.filter = filter === 'connected' ? 'connected' : 'all';
        this.updateFilterControls();
        this.renderSearchResults();
        this.scheduleDraw();
    }

    updateFilterControls() {
        this.allFilter.setAttribute('aria-pressed', String(this.filter === 'all'));
        this.connectedFilter.setAttribute(
            'aria-pressed',
            String(this.filter === 'connected')
        );
        this.visibleCount.textContent = String(this.visibleNodes().length);
    }

    visibleNodes() {
        return this.filter === 'connected'
            ? this.nodes.filter(node => node.degree > 0)
            : this.nodes;
    }

    selectedNode() {
        return this.nodes.find(node => sameItemID(
            node.itemID,
            this.selectedItemID
        )) || null;
    }

    openPaper(node) {
        if (!node || typeof this.onOpenPaper !== 'function') return;
        this.navigationError = '';
        this.renderStatus();
        Promise.resolve(this.onOpenPaper(node)).then(() => {
            this.navigationError = '';
            this.renderStatus();
        }).catch(error => {
            this.navigationError = this.message('graph.openFailed');
            try {
                this.onError?.(error);
            }
            catch {
                // Error reporting cannot make the graph view unusable.
            }
            this.renderStatus();
        });
    }

    resetView() {
        this.transform = { x: 0, y: 0, scale: 1 };
        const node = this.selectedNode();
        if (node) {
            this.keepFocusedNodeCentered = true;
            this.centerNode(node);
        }
        this.scheduleDraw();
    }

    zoomBy(factor, point = null) {
        this.keepFocusedNodeCentered = false;
        const nextScale = clamp(
            this.transform.scale * factor,
            MIN_SCALE,
            MAX_SCALE
        );
        const anchor = point || {
            x: (this.cssWidth || DEFAULT_WIDTH) / 2,
            y: (this.cssHeight || DEFAULT_HEIGHT) / 2,
        };
        const worldX = (anchor.x - this.transform.x) / this.transform.scale;
        const worldY = (anchor.y - this.transform.y) / this.transform.scale;
        this.transform.x = anchor.x - worldX * nextScale;
        this.transform.y = anchor.y - worldY * nextScale;
        this.transform.scale = nextScale;
        this.scheduleDraw();
    }

    centerNode(node) {
        if (!node
            || !Number.isFinite(node.x)
            || !Number.isFinite(node.y)) return;
        this.transform.x = (this.cssWidth || DEFAULT_WIDTH) / 2
            - node.x * this.transform.scale;
        this.transform.y = (this.cssHeight || DEFAULT_HEIGHT) / 2
            - node.y * this.transform.scale;
    }

    handleWheel(event) {
        event.preventDefault?.();
        const point = this.eventPoint(event);
        this.zoomBy(event.deltaY > 0 ? 0.9 : 1.1, point);
    }

    handlePointerDown(event) {
        this.keepFocusedNodeCentered = false;
        this.hideHoverDetails();
        const point = this.eventPoint(event);
        const node = this.hitTest(event);
        this.pointer = {
            id: event.pointerId,
            node,
            x: point.x,
            y: point.y,
            transformX: this.transform.x,
            transformY: this.transform.y,
        };
        this.canvas.setPointerCapture?.(event.pointerId);
        if (node) {
            this.focus(node.itemID, { center: false });
            node.fx = node.x;
            node.fy = node.y;
            this.simulation?.alphaTarget?.(0.2)?.restart?.();
        }
    }

    handlePointerMove(event) {
        if (!this.pointer) {
            const node = this.hitTest(event);
            this.canvas.dataset.hover = node ? 'node' : '';
            this.showHoverDetails(node, this.eventPoint(event));
            return;
        }
        const point = this.eventPoint(event);
        const deltaX = point.x - this.pointer.x;
        const deltaY = point.y - this.pointer.y;
        if (this.pointer.node) {
            this.pointer.node.fx = (
                point.x - this.transform.x
            ) / this.transform.scale;
            this.pointer.node.fy = (
                point.y - this.transform.y
            ) / this.transform.scale;
        }
        else {
            this.transform.x = this.pointer.transformX + deltaX;
            this.transform.y = this.pointer.transformY + deltaY;
        }
        this.scheduleDraw();
    }

    handlePointerUp(event) {
        if (!this.pointer) return;
        if (this.pointer.node) {
            this.pointer.node.fx = null;
            this.pointer.node.fy = null;
            this.simulation?.alphaTarget?.(0);
        }
        this.canvas.releasePointerCapture?.(event.pointerId);
        this.pointer = null;
    }

    showHoverDetails(node, point) {
        if (!node) {
            this.hideHoverDetails();
            return;
        }
        this.hoverTitle.textContent = node.title || this.message('graph.untitled');
        this.hoverMeta.textContent = this.message('graph.hoverConnections', {
            references: node.outDegree || 0,
            citedBy: node.inDegree || 0,
        });
        this.hoverDetails.style.left = `${clamp(
            point.x + 12,
            8,
            Math.max(8, (this.cssWidth || DEFAULT_WIDTH) - 250)
        )}px`;
        this.hoverDetails.style.top = `${clamp(
            point.y + 12,
            8,
            Math.max(8, (this.cssHeight || DEFAULT_HEIGHT) - 90)
        )}px`;
        this.hoverDetails.hidden = false;
    }

    hideHoverDetails() {
        if (this.hoverDetails) this.hoverDetails.hidden = true;
        if (this.canvas?.dataset) this.canvas.dataset.hover = '';
    }

    hitTest(event) {
        const point = this.eventPoint(event);
        const worldX = (point.x - this.transform.x) / this.transform.scale;
        const worldY = (point.y - this.transform.y) / this.transform.scale;
        return [...this.visibleNodes()].reverse().find(node => {
            const dx = node.x - worldX;
            const dy = node.y - worldY;
            const radius = nodeRadius(node) + 4 / this.transform.scale;
            return dx * dx + dy * dy <= radius * radius;
        }) || null;
    }

    eventPoint(event) {
        const bounds = this.canvas.getBoundingClientRect?.() || { left: 0, top: 0 };
        return {
            x: finite(event.clientX, 0) - finite(bounds.left, 0),
            y: finite(event.clientY, 0) - finite(bounds.top, 0),
        };
    }

    listen(target, type, listener, options) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, listener, options);
        this.listeners.push(() => target.removeEventListener(
            type,
            listener,
            options
        ));
    }

    iconButton(action, icon, label) {
        const button = this.element('button', 'citation-graph-icon-button');
        button.type = 'button';
        button.dataset.action = action;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.appendChild(createLucideIcon(this.document, icon, { size: 16 }));
        return button;
    }

    textButton(text, className) {
        const button = this.element('button', className, text);
        button.type = 'button';
        return button;
    }

    element(tagName, className = '', text = null) {
        const element = this.document.createElementNS(XHTML_NAMESPACE, tagName);
        if (className) element.className = className;
        if (text !== null && text !== undefined) element.textContent = text;
        return element;
    }

    message(key, variables) {
        return this.t(key, variables);
    }

    countMessage(kind, count) {
        const one = count === 1;
        const key = `graph.${kind}Count${one ? 'One' : 'Many'}`;
        return this.message(key, { count });
    }

    nodeForControl(control) {
        const itemID = control?.dataset?.itemId;
        return this.nodes.find(node => sameItemID(node.itemID, itemID)) || null;
    }

    prefersReducedMotion() {
        return this.motionQuery?.matches === true;
    }

    canvasTextColor() {
        const computed = this.ownerWindow.getComputedStyle?.(this.root)?.color;
        if (computed && computed !== 'CanvasText') return computed;
        return this.ownerWindow.matchMedia?.('(prefers-color-scheme: dark)')?.matches
            ? '#f3f4f6'
            : '#202124';
    }
}

function createDefaultSimulation(nodes, edges, { width, height }) {
    return forceSimulation(nodes)
        .force('link', forceLink(edges).id(node => node.id).distance(90).strength(0.25))
        .force('charge', forceManyBody().strength(-90))
        .force('center', forceCenter(width / 2, height / 2))
        .force('collision', forceCollide(node => nodeRadius(node) + 8))
        .alpha(0.8)
        .restart();
}

function normalizeEdges(edges, nodeByID) {
    const normalized = [];
    for (const edge of Array.isArray(edges) ? edges : []) {
        const sourceID = typeof edge?.source === 'object'
            ? edge.source.id
            : edge?.source;
        const targetID = typeof edge?.target === 'object'
            ? edge.target.id
            : edge?.target;
        const source = nodeByID.get(sourceID);
        const target = nodeByID.get(targetID);
        if (source && target && source !== target) normalized.push({ source, target });
    }
    return normalized;
}

function nodeRadius(node) {
    return 6 + Math.min(8, Math.sqrt(Math.max(0, node.degree || 0)) * 2.4);
}

function truncateLabel(value) {
    const text = String(value || '').trim();
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

function warningCount(warnings, code) {
    return warnings.filter(warning => warning?.code === code).reduce(
        (total, warning) => total + (
            Number.isSafeInteger(warning.count) && warning.count > 0
                ? warning.count
                : 1
        ),
        0
    );
}

function finite(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function sameItemID(left, right) {
    return left !== null
        && left !== undefined
        && right !== null
        && right !== undefined
        && String(left) === String(right);
}
