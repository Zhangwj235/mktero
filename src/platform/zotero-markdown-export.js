const FILE_PICKER_CONTRACT = '@mozilla.org/filepicker;1';
const MARKDOWN_EXTENSION = '.md';
const MARKDOWN_FILTER_LABEL = 'Markdown';
const MARKDOWN_FILTER_PATTERN = '*.md';
const DEFAULT_EXPORT_NAME = 'document';
const MAX_EXPORT_NAME_LENGTH = 120;
// Windows, macOS, and Linux collectively reject these in file names.
const INVALID_FILE_NAME_CHARACTERS = /[\\/:*?"<>|]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export function markdownExportFileName(title) {
    const normalized = String(title ?? '')
        .replace(CONTROL_CHARACTERS, ' ')
        .replace(INVALID_FILE_NAME_CHARACTERS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const base = normalized
        .slice(0, MAX_EXPORT_NAME_LENGTH)
        // Leading dots hide the file on Unix; trailing dots break Windows.
        .replace(/^\.+/, '')
        .replace(/[\s.]+$/, '')
        .trim();
    return (base || DEFAULT_EXPORT_NAME) + MARKDOWN_EXTENSION;
}

function initFilePicker(picker, window, title, mode) {
    // Firefox 115 and later expect a BrowsingContext, while older Zotero
    // builds still pass the DOM window. Try the modern signature first.
    const browsingContext = window?.browsingContext;
    if (browsingContext) {
        try {
            picker.init(browsingContext, title, mode);
            return;
        }
        catch {
            // Fall through to the legacy DOM window signature.
        }
    }
    picker.init(window, title, mode);
}

export function createZoteroMarkdownExport({ components, io } = {}) {
    return {
        async save({ markdown, suggestedName, window, title } = {}) {
            if (typeof markdown !== 'string' || !markdown.trim()) {
                throw new Error('Markdown export content is unavailable');
            }
            const interfaces = components?.interfaces?.nsIFilePicker;
            const picker = components?.classes?.[FILE_PICKER_CONTRACT]
                ?.createInstance?.(interfaces);
            if (!interfaces
                || typeof picker?.init !== 'function'
                || typeof picker?.open !== 'function') {
                throw new Error('The file picker is unavailable');
            }
            if (typeof io?.writeUTF8 !== 'function') {
                throw new Error('Markdown export storage is unavailable');
            }
            initFilePicker(picker, window, title, interfaces.modeSave);
            picker.appendFilter?.(
                MARKDOWN_FILTER_LABEL,
                MARKDOWN_FILTER_PATTERN
            );
            picker.defaultExtension = MARKDOWN_EXTENSION.slice(1);
            picker.defaultString = suggestedName
                || markdownExportFileName(title || '');
            const result = await new Promise(resolve => {
                picker.open(resolve);
            });
            if (result === interfaces.returnCancel) {
                return { cancelled: true, path: null };
            }
            const path = picker.file?.path;
            if (!path) {
                throw new Error('The selected export path is unavailable');
            }
            await io.writeUTF8(path, markdown);
            return { cancelled: false, path };
        },
    };
}
