import { EDITOR_TOOLBAR_GROUPS } from '../editor/editor-commands.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function createEditorToolbar(document) {
    const toolbarButtons = [];
    const editorToolbar = createElement(document, 'div', {
        id: 'mktero-editor-toolbar',
        class: 'editor-toolbar',
        role: 'toolbar',
        'aria-label': 'Markdown 编辑工具',
    });
    for (const commands of EDITOR_TOOLBAR_GROUPS) {
        const group = createElement(document, 'div', {
            class: 'editor-toolbar-group',
            role: 'group',
        });
        for (const descriptor of commands) {
            const button = createElement(document, 'button', {
                class: 'editor-toolbar-button',
                type: 'button',
                title: descriptor.label,
                'aria-label': descriptor.label,
                'data-command': descriptor.command,
            });
            button.disabled = true;
            button.appendChild(createToolbarIcon(document, descriptor.icon));
            group.appendChild(button);
            toolbarButtons.push({ button, command: descriptor.command });
        }
        editorToolbar.appendChild(group);
    }
    return { editorToolbar, toolbarButtons };
}

export function bindEditorToolbar({ toolbarButtons, runCommand, listen }) {
    for (const { button, command } of toolbarButtons) {
        listen(button, 'mousedown', event => event.preventDefault());
        listen(button, 'click', () => runCommand(command));
    }
}

export function createToolbarButton(document, {
    id,
    label,
    icon,
    pressed,
}) {
    const attributes = {
        id,
        class: 'editor-toolbar-button',
        type: 'button',
        title: label,
        'aria-label': label,
    };
    if (pressed !== undefined) {
        attributes['aria-pressed'] = String(pressed);
    }
    const button = createElement(document, 'button', attributes);
    button.appendChild(createToolbarIcon(document, icon));
    return button;
}

function createToolbarIcon(document, parts) {
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    setAttributes(svg, {
        class: 'editor-toolbar-icon',
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
    });
    for (const [tagName, attributes] of parts) {
        const part = document.createElementNS(SVG_NAMESPACE, tagName);
        setAttributes(part, attributes);
        svg.appendChild(part);
    }
    return svg;
}

function createElement(document, tagName, attributes) {
    const element = document.createElementNS(XHTML_NAMESPACE, tagName);
    setAttributes(element, attributes);
    return element;
}

function setAttributes(element, attributes) {
    for (const [name, value] of Object.entries(attributes)) {
        element.setAttribute(name, value);
    }
}
