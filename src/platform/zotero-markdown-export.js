import { toUint8Array } from '../mineru/binary.js';

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

const ASSET_DIRECTORY_NAME = 'assets';
const JPEG_SIGNATURE = [0xFF, 0xD8, 0xFF];
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47];
const GIF_SIGNATURE = [0x47, 0x49, 0x46];
const WEBP_RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_FORMAT_SIGNATURE = [0x57, 0x45, 0x42, 0x50];
const MIME_EXTENSIONS = new Map([
    ['image/jpeg', 'jpg'],
    ['image/jpg', 'jpg'],
    ['image/png', 'png'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
]);

function startsWithBytes(data, signature) {
    if (!data || data.length < signature.length) return false;
    for (let index = 0; index < signature.length; index++) {
        if (data[index] !== signature[index]) return false;
    }
    return true;
}

// Detects the real image container from the file header, falling back to the
// declared MIME type and finally to any image extension already present in the
// asset path. MinerU caches images as extension-less `.bin` blobs, so the magic
// bytes are the authoritative signal.
function detectImageExtension(data, mimeType, assetPath) {
    if (startsWithBytes(data, JPEG_SIGNATURE)) return 'jpg';
    if (startsWithBytes(data, PNG_SIGNATURE)) return 'png';
    if (startsWithBytes(data, GIF_SIGNATURE)) return 'gif';
    if (startsWithBytes(data, WEBP_RIFF_SIGNATURE)
        && data.length >= 12
        && startsWithBytes(data.subarray(8, 12), WEBP_FORMAT_SIGNATURE)) {
        return 'webp';
    }
    const mimeExtension = MIME_EXTENSIONS.get(String(mimeType || '').toLowerCase());
    if (mimeExtension) return mimeExtension;
    const pathExtension = pathImageExtension(assetPath);
    if (pathExtension) return pathExtension;
    return 'jpg';
}

function pathImageExtension(assetPath) {
    const normalized = String(assetPath || '').replace(/\\/g, '/');
    const base = normalized.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return '';
    const extension = base.slice(dot + 1).toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension)
        ? (extension === 'jpeg' ? 'jpg' : extension)
        : '';
}

function baseNameFromAssetPath(assetPath) {
    const normalized = String(assetPath || '').replace(/\\/g, '/');
    let base = normalized.split('/').pop() || 'image';
    const dot = base.lastIndexOf('.');
    if (dot > 0) base = base.slice(0, dot);
    base = base
        .replace(CONTROL_CHARACTERS, ' ')
        .replace(INVALID_FILE_NAME_CHARACTERS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return base || 'image';
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

function getParentDirectory(pathUtils, path) {
    if (typeof pathUtils?.parent === 'function') {
        try {
            const parent = pathUtils.parent(path);
            if (parent) return parent;
        }
        catch {
            // Fall through to string parsing.
        }
    }
    const normalized = String(path).replace(/\\/g, '/');
    const index = normalized.lastIndexOf('/');
    return index > 0 ? normalized.slice(0, index) : '.';
}

// Maps every image reference in the Markdown to the exported relative path. The
// resolution mirrors the viewer's `resolveImageURL` so exported links stay in
// sync with what is actually rendered.
function rewriteMarkdownImageLinks(markdown, assetKeyToRelative, assetBasePath) {
    const resolver = source => {
        const raw = String(source || '').split(/[?#]/, 1)[0];
        if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) {
            return null;
        }
        let decoded;
        try {
            decoded = decodeURIComponent(raw);
        }
        catch {
            return null;
        }
        const key = resolveZipPath(assetBasePath || '', decoded);
        return assetKeyToRelative.get(key) || null;
    };
    let output = markdown;
    output = output.replace(
        /!\[([^\]]*)\]\((\S+?)((?:\s+"[^"]*")?)\)/g,
        (full, alt, url, title) => {
            const replacement = resolver(url);
            return replacement ? `![${alt}](${replacement}${title})` : full;
        }
    );
    output = output.replace(
        /<img\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/gi,
        (full, before, url, after) => {
            const replacement = resolver(url);
            return replacement ? `<img${before}src="${replacement}"${after}>` : full;
        }
    );
    output = output.replace(
        /^\[([^\]]+)\]:\s*(\S+)((?:\s+"[^"]*")?)\s*$/gm,
        (full, label, url, title) => {
            const replacement = resolver(url);
            return replacement ? `[${label}]: ${replacement}${title}` : full;
        }
    );
    return output;
}

// Writes every supplied image next to the chosen Markdown file, inside an
// `assets` directory, and returns the rewritten Markdown whose image links point
// at those local files.
export async function exportMarkdownWithAssets({
    io,
    pathUtils,
    markdownPath,
    markdown,
    assets,
    assetBasePath,
} = {}) {
    if (!Array.isArray(assets) || !assets.length) {
        return { assetDir: null, markdown, files: [] };
    }
    if (typeof io?.write !== 'function'
        || typeof io?.makeDirectory !== 'function') {
        throw new Error('Image export storage is unavailable');
    }
    if (typeof pathUtils?.join !== 'function') {
        throw new Error('Image export path utilities are unavailable');
    }

    const parentDirectory = getParentDirectory(pathUtils, markdownPath);
    const assetDir = pathUtils.join(parentDirectory, ASSET_DIRECTORY_NAME);
    await io.makeDirectory(assetDir, { ignoreExisting: true });

    const assetKeyToRelative = new Map();
    const usedNames = new Set();
    const files = [];
    for (const asset of assets) {
        if (!asset?.path || !asset?.data) continue;
        const key = normalizeZipPath(asset.path);
        if (assetKeyToRelative.has(key)) continue;
        const base = baseNameFromAssetPath(asset.path);
        const extension = detectImageExtension(
            toUint8Array(asset.data, 'image'),
            asset.mimeType,
            asset.path
        );
        let fileName = `${base}.${extension}`;
        let suffix = 1;
        while (usedNames.has(fileName)) {
            suffix += 1;
            fileName = `${base}-${suffix}.${extension}`;
        }
        usedNames.add(fileName);
        const absolutePath = pathUtils.join(assetDir, fileName);
        const data = toUint8Array(asset.data, 'image');
        await io.write(absolutePath, data, { tmpPath: `${absolutePath}.tmp` });
        assetKeyToRelative.set(key, `${ASSET_DIRECTORY_NAME}/${fileName}`);
        files.push({ fileName, absolutePath, size: data.length });
    }

    const rewritten = rewriteMarkdownImageLinks(
        markdown,
        assetKeyToRelative,
        assetBasePath
    );
    return { assetDir, markdown: rewritten, files };
}

export function createZoteroMarkdownExport({ components, io, pathUtils } = {}) {
    return {
        async save({ markdown, suggestedName, window, title, assets, assetBasePath } = {}) {
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
            let finalMarkdown = markdown;
            let assetDir = null;
            let exportedAssets = 0;
            if (Array.isArray(assets) && assets.length) {
                try {
                    const exported = await exportMarkdownWithAssets({
                        io,
                        pathUtils,
                        markdownPath: path,
                        markdown,
                        assets,
                        assetBasePath,
                    });
                    finalMarkdown = exported.markdown;
                    assetDir = exported.assetDir;
                    exportedAssets = exported.files.length;
                }
                catch (error) {
                    if (typeof Zotero !== 'undefined') Zotero.logError?.(error);
                }
            }
            await io.writeUTF8(path, finalMarkdown);
            return { cancelled: false, path, assetDir, exportedAssets };
        },
    };
}
