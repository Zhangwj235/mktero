import {
    CONVERSION_PROGRESS,
    normalizeConversionProgress,
} from '../core/conversion-progress.js';

export function createLoadingPresentation(model = {}) {
    if (model.status !== 'loading') return { visible: false };

    const progress = normalizeConversionProgress(model.progress);
    const preserveContent = Boolean(model.preserveContent);
    return {
        visible: true,
        preserveContent,
        progress,
        progressLabel: `${progress}%`,
        title: preserveContent ? 'Reparsing PDF…' : 'Converting PDF…',
        detail: progressDetail(progress),
        hint: preserveContent
            ? 'The current Markdown remains available until the new result is ready.'
            : 'This can take a few minutes. Keep this tab open until conversion finishes.',
    };
}

function progressDetail(progress) {
    if (progress < CONVERSION_PROGRESS.UPLOADING) {
        return 'Preparing the PDF.';
    }
    if (progress < CONVERSION_PROGRESS.PARSING) {
        return 'Uploading the PDF for conversion.';
    }
    if (progress < CONVERSION_PROGRESS.DOWNLOADING) {
        return 'The PDF is being converted to Markdown.';
    }
    return 'Downloading and preparing the Markdown result.';
}
