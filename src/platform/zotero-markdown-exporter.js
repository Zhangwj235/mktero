import {
    createMarkdownExportFileName,
    createMarkdownExportPlan,
} from '../markdown/markdown-export.js';
import { translateEnglish } from '../i18n/localization.js';

export function createZoteroMarkdownExporter({
    createFilePicker,
    ioUtils,
    pathUtils,
    createID,
    translate = translateEnglish,
}) {
    if (typeof createFilePicker !== 'function') {
        throw new TypeError('A Zotero file picker factory is required');
    }
    if (!ioUtils || !pathUtils) {
        throw new TypeError('Zotero file adapters are required');
    }
    if (typeof createID !== 'function') {
        throw new TypeError('A Markdown export ID factory is required');
    }
    return {
        async export({ ownerWindow, title, markdown, assets, assetBasePath }) {
            const picker = createFilePicker();
            picker.init(
                ownerWindow,
                translate('viewer.exportMarkdownDialogTitle'),
                picker.modeSave
            );
            picker.appendFilter(
                translate('viewer.exportMarkdownFilter'),
                '*.md'
            );
            const defaultFileName = createMarkdownExportFileName(
                title,
                translate('viewer.exportMarkdownDefaultFileName')
            );
            picker.defaultExtension = 'md';
            picker.defaultString = defaultFileName;
            const result = await picker.show();
            if (result === picker.returnCancel) {
                return { status: 'cancelled' };
            }
            const selectedPath = String(picker.file || '');
            if (!selectedPath) {
                throw new Error('The Markdown export path is unavailable');
            }
            const outputPath = /\.md$/i.test(selectedPath)
                ? selectedPath
                : selectedPath + '.md';
            if (outputPath !== selectedPath
                && await ioUtils.exists(outputPath)) {
                throw new Error(
                    'The Markdown export path already exists without confirmation'
                );
            }
            const outputFileName = pathUtils.filename(outputPath);
            const outputStem = outputFileName.replace(/\.md$/i, '')
                || defaultFileName.replace(/\.md$/i, '');
            const outputDirectory = pathUtils.parent(outputPath);
            const preferredAssetDirectoryName = outputStem + '.assets';
            let plan = createMarkdownExportPlan({
                markdown,
                assets,
                assetBasePath,
                assetDirectoryName: preferredAssetDirectoryName,
            });
            let assetDirectoryPath = null;
            const exportID = normalizeExportID(createID());
            const temporaryMarkdownPath = outputPath
                + '.mktero-' + exportID + '.tmp';
            let createdAssetDirectory = false;
            try {
                if (plan.assets.length) {
                    const available = await createAvailableAssetDirectory({
                        directory: outputDirectory,
                        preferredName: preferredAssetDirectoryName,
                        ioUtils,
                        pathUtils,
                    });
                    assetDirectoryPath = available.path;
                    createdAssetDirectory = true;
                    if (available.name !== preferredAssetDirectoryName) {
                        plan = createMarkdownExportPlan({
                            markdown,
                            assets,
                            assetBasePath,
                            assetDirectoryName: available.name,
                        });
                    }
                    await writeExportAssets(
                        assetDirectoryPath,
                        plan.assets,
                        ioUtils,
                        pathUtils
                    );
                }
                await ioUtils.writeUTF8(outputPath, plan.markdown, {
                    tmpPath: temporaryMarkdownPath,
                });
            }
            catch (error) {
                await ioUtils.remove(temporaryMarkdownPath, {
                    ignoreAbsent: true,
                }).catch(() => {});
                if (createdAssetDirectory) {
                    await ioUtils.remove(assetDirectoryPath, {
                        recursive: true,
                        ignoreAbsent: true,
                    }).catch(() => {});
                }
                throw error;
            }
            return {
                status: 'exported',
                path: outputPath,
                assetDirectoryPath,
                assetCount: plan.assets.length,
            };
        },
    };
}

async function createAvailableAssetDirectory({
    directory,
    preferredName,
    ioUtils,
    pathUtils,
}) {
    for (let index = 1; index <= 1_000; index += 1) {
        const name = index === 1
            ? preferredName
            : preferredName + '-' + index;
        const candidate = pathUtils.join(directory, name);
        if (await ioUtils.exists(candidate)) continue;
        try {
            await ioUtils.makeDirectory(candidate, {
                ignoreExisting: false,
            });
            return { name, path: candidate };
        }
        catch (error) {
            if (await ioUtils.exists(candidate)) continue;
            throw error;
        }
    }
    throw new Error('No safe Markdown export asset directory is available');
}

async function writeExportAssets(rootPath, assets, ioUtils, pathUtils) {
    const createdDirectories = new Set();
    for (const asset of assets) {
        const segments = asset.relativePath.split('/');
        if (segments.length > 1) {
            const directory = pathUtils.join(
                rootPath,
                ...segments.slice(0, -1)
            );
            if (!createdDirectories.has(directory)) {
                await ioUtils.makeDirectory(directory, {
                    ignoreExisting: true,
                });
                createdDirectories.add(directory);
            }
        }
        await ioUtils.write(
            pathUtils.join(rootPath, ...segments),
            asset.data
        );
    }
}

function normalizeExportID(value) {
    const id = String(value || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        throw new Error('The Markdown export request ID is invalid');
    }
    return id;
}
