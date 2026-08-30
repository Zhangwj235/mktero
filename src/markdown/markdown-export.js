import { GFM, parser } from '@lezer/markdown';
import { toUint8Array } from '../mineru/binary.js';

export const MAX_EXPORT_FILE_STEM_CODE_POINTS = 180;
export const MAX_EXPORT_MARKDOWN_BYTES = 50 * 1024 * 1024;
export const MAX_EXPORT_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_EXPORT_TOTAL_ASSET_BYTES = 150 * 1024 * 1024;
export const MAX_EXPORT_ASSETS = 2_000;
const RESERVED_WINDOWS_FILE_STEMS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MARKDOWN_PARSER = parser.configure(GFM);

export function createMarkdownExportDirectoryName(
    title,
    fallbackTitle = 'Mktero'
) {
    return normalizeExportFileStem(title)
        || normalizeExportFileStem(fallbackTitle)
        || 'Mktero';
}

export function createMarkdownExportFileName(title, fallbackTitle = 'Mktero') {
    return createMarkdownExportDirectoryName(title, fallbackTitle) + '.md';
}

function normalizeExportFileStem(value) {
    let stem = String(value || '').trim().replace(/\.pdf$/i, '');
    stem = stem
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[ .]+|[ .]+$/g, '');
    stem = [...stem].slice(0, MAX_EXPORT_FILE_STEM_CODE_POINTS).join('')
        .replace(/[ .]+$/g, '');
    if (RESERVED_WINDOWS_FILE_STEMS.test(stem)) stem = '_' + stem;
    return stem;
}

export function createMarkdownExportPlan({
    markdown,
    assets = [],
    assetBasePath = '',
    assetDirectoryName,
}) {
    if (typeof markdown !== 'string'
        || new TextEncoder().encode(markdown).length
            > MAX_EXPORT_MARKDOWN_BYTES) {
        throw new Error('The Markdown export source is invalid');
    }
    const directoryName = normalizeAssetDirectoryName(assetDirectoryName);
    const basePath = normalizeRelativePath(assetBasePath, { allowEmpty: true });
    const normalizedAssets = normalizeExportAssets(assets, basePath);
    const assetsByPath = new Map();
    for (const asset of normalizedAssets) {
        assetsByPath.set(asset.sourcePath, asset);
        assetsByPath.set(asset.relativePath, asset);
    }
    const replacements = normalizedAssets.length
        ? collectImageURLReplacements(
            markdown,
            basePath,
            directoryName,
            assetsByPath
        )
        : [];
    let exportedMarkdown = markdown;
    for (const replacement of replacements.sort((left, right) => (
        right.from - left.from
    ))) {
        exportedMarkdown = exportedMarkdown.slice(0, replacement.from)
            + replacement.value
            + exportedMarkdown.slice(replacement.to);
    }
    return {
        markdown: exportedMarkdown,
        assets: normalizedAssets.map(({ sourcePath, ...asset }) => asset),
    };
}

function normalizeAssetDirectoryName(value) {
    const name = String(value || '').trim();
    if (!name
        || name === '.'
        || name === '..'
        || name.includes('/')
        || name.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('The Markdown export asset directory is invalid');
    }
    return name;
}

function normalizeExportAssets(assets, basePath) {
    if (!Array.isArray(assets) || assets.length > MAX_EXPORT_ASSETS) {
        throw new Error('The Markdown export images are invalid');
    }
    const sourcePaths = new Set();
    const relativePaths = new Set();
    let totalBytes = 0;
    return assets.map(source => {
        const sourcePath = normalizeRelativePath(source?.path);
        const relativePath = basePath && sourcePath.startsWith(basePath + '/')
            ? sourcePath.slice(basePath.length + 1)
            : sourcePath;
        const mimeType = String(source?.mimeType || '');
        const data = toUint8Array(source?.data, 'Markdown export image');
        totalBytes += data.length;
        if (!/^image\/[A-Za-z0-9.+-]+$/.test(mimeType)
            || data.length > MAX_EXPORT_ASSET_BYTES
            || totalBytes > MAX_EXPORT_TOTAL_ASSET_BYTES
            || sourcePaths.has(sourcePath)
            || relativePaths.has(relativePath)) {
            throw new Error('The Markdown export image metadata is invalid');
        }
        sourcePaths.add(sourcePath);
        relativePaths.add(relativePath);
        return { sourcePath, relativePath, mimeType, data };
    });
}

function collectImageURLReplacements(
    markdown,
    basePath,
    directoryName,
    assetsByPath
) {
    const replacements = [];
    const imageReferenceLabels = new Set();
    const tree = MARKDOWN_PARSER.parse(markdown);
    tree.iterate({
        enter(node) {
            if (node.name !== 'Image') return undefined;
            const url = node.node.getChild('URL');
            if (url) {
                addImageURLReplacement(
                    replacements,
                    markdown,
                    url,
                    basePath,
                    directoryName,
                    assetsByPath
                );
            }
            const normalizedLabel = url
                ? ''
                : referenceLabelForImage(node.node, markdown);
            if (normalizedLabel) imageReferenceLabels.add(normalizedLabel);
            return false;
        },
    });
    if (!imageReferenceLabels.size) return replacements;
    tree.iterate({
        enter(node) {
            if (node.name !== 'LinkReference') return undefined;
            const label = node.node.getChild('LinkLabel');
            const url = node.node.getChild('URL');
            if (!label || !url
                || !imageReferenceLabels.has(normalizeReferenceLabel(
                    markdown.slice(label.from, label.to)
                ))) {
                return false;
            }
            addImageURLReplacement(
                replacements,
                markdown,
                url,
                basePath,
                directoryName,
                assetsByPath
            );
            return false;
        },
    });
    return replacements;
}

function referenceLabelForImage(image, markdown) {
    const explicitLabel = image.getChild('LinkLabel');
    const normalizedExplicitLabel = explicitLabel
        ? normalizeReferenceLabel(
            markdown.slice(explicitLabel.from, explicitLabel.to)
        )
        : '';
    if (normalizedExplicitLabel) return normalizedExplicitLabel;
    const marks = image.getChildren('LinkMark');
    const closingAlt = marks.find(mark => (
        markdown.slice(mark.from, mark.to) === ']'
    ));
    if (!marks.length || !closingAlt) return '';
    return normalizeReferenceLabel(
        markdown.slice(marks[0].to, closingAlt.from)
    );
}

function addImageURLReplacement(
    replacements,
    markdown,
    url,
    basePath,
    directoryName,
    assetsByPath
) {
    const asset = resolveExportAsset(
        markdown.slice(url.from, url.to),
        basePath,
        assetsByPath
    );
    if (!asset) return;
    replacements.push({
        from: url.from,
        to: url.to,
        value: encodeExportPath(directoryName + '/' + asset.relativePath),
    });
}

function resolveExportAsset(href, basePath, assetsByPath) {
    let source = String(href || '').trim();
    if (source.startsWith('<') && source.endsWith('>')) {
        source = source.slice(1, -1);
    }
    source = source.split(/[?#]/, 1)[0];
    if (!source
        || /^[a-z][a-z0-9+.-]*:/i.test(source)
        || source.startsWith('/')
        || source.includes('\\')) {
        return null;
    }
    try {
        source = decodeURIComponent(source);
    }
    catch {
        return null;
    }
    if (!source
        || /^[a-z][a-z0-9+.-]*:/i.test(source)
        || source.startsWith('/')
        || source.includes('\\')
        || source.includes('\u0000')) {
        return null;
    }
    const resolvedPath = resolveAssetSourcePath(basePath, source);
    if (!resolvedPath) return null;
    let directPath = '';
    try {
        directPath = normalizeRelativePath(source);
    }
    catch {
        directPath = '';
    }
    return assetsByPath.get(resolvedPath)
        || assetsByPath.get(directPath)
        || null;
}

function resolveAssetSourcePath(basePath, relativePath) {
    const segments = basePath ? basePath.split('/') : [];
    for (const segment of relativePath.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!segments.length) return null;
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    const resolved = segments.join('/');
    return resolved && resolved.length <= 1_024 ? resolved : null;
}

function normalizeReferenceLabel(value) {
    return String(value)
        .replace(/^\[|\]$/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function normalizeRelativePath(value, { allowEmpty = false } = {}) {
    const source = String(value || '');
    if ((!source && !allowEmpty)
        || source.startsWith('/')
        || source.includes('\\')
        || source.includes('\u0000')) {
        throw new Error('The Markdown export image path is invalid');
    }
    const segments = [];
    for (const segment of source.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            throw new Error('The Markdown export image path escapes its root');
        }
        segments.push(segment);
    }
    const normalized = segments.join('/');
    if ((!normalized && !allowEmpty) || normalized.length > 1_024) {
        throw new Error('The Markdown export image path is invalid');
    }
    return normalized;
}

function encodeExportPath(path) {
    return path.split('/').map(segment => (
        encodeURIComponent(segment).replace(/[()]/g, character => (
            '%' + character.codePointAt(0).toString(16).toUpperCase()
        ))
    )).join('/');
}
