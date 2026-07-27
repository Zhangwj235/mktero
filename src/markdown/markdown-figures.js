const ACADEMIC_FIGURE_CAPTION_PATTERN = /^(?:algorithm|chart|fig\.?|figure|scheme|table)[ \t]+(?:s?\d+[a-z]?|[ivxlcdm]+[a-z]?)[.:][ \t]+\S/iu;
const EMPTY_IMAGE_LINE_PATTERN = /^( {0,3})!\[[ \t]*\](\([^\r\n]+\))[ \t]*(?:\r?\n)?$/;
const MARKDOWN_IMAGE_LINE_PATTERN = /^ {0,3}!\[[^\]\r\n]*\]\([^\r\n]+\)[ \t]*(?:\r?\n)?$/;
const BLANK_LINE_PATTERN = /^[ \t]*(?:\r?\n)?$/;

export function parseAcademicFigureCaption(value) {
    const text = String(value || '').trim();
    if (!ACADEMIC_FIGURE_CAPTION_PATTERN.test(text)) return null;
    return { text };
}

export function normalizeMarkdownFigureCaptions(markdown) {
    const lines = String(markdown).match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const output = [];
    let activeFence = null;

    for (let index = 0; index < lines.length; index++) {
        const fence = markdownFence(lines[index]);
        if (activeFence) {
            output.push(lines[index]);
            if (fence
                && fence.character === activeFence.character
                && fence.length >= activeFence.length
                && !fence.trailing.trim()) {
                activeFence = null;
            }
            continue;
        }
        if (fence) {
            activeFence = fence;
            output.push(lines[index]);
            continue;
        }

        const image = EMPTY_IMAGE_LINE_PATTERN.exec(lines[index]);
        if (!image || previousNearbyLineIsImage(lines, index)) {
            output.push(lines[index]);
            continue;
        }

        let captionIndex = index + 1;
        if (BLANK_LINE_PATTERN.test(lines[captionIndex] || '')) {
            captionIndex++;
        }
        const captionLine = lines[captionIndex];
        if (captionLine === undefined) {
            output.push(lines[index]);
            continue;
        }
        const captionEnding = /\r?\n$/.exec(captionLine)?.[0] || '';
        const caption = parseAcademicFigureCaption(
            captionLine.slice(0, captionLine.length - captionEnding.length)
        );
        if (!caption) {
            output.push(lines[index]);
            continue;
        }

        output.push(
            `${image[1]}![${escapeImageDescription(caption.text)}]`
                + `${image[2]}${captionEnding}`
        );
        index = captionIndex;
    }

    return output.join('');
}

function previousNearbyLineIsImage(lines, index) {
    let previousIndex = index - 1;
    if (BLANK_LINE_PATTERN.test(lines[previousIndex] || '')) previousIndex--;
    return MARKDOWN_IMAGE_LINE_PATTERN.test(lines[previousIndex] || '');
}

function markdownFence(line) {
    const source = String(line).replace(/\r?\n$/, '');
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(source);
    if (!match) return null;
    return {
        character: match[1][0],
        length: match[1].length,
        trailing: match[2],
    };
}

function escapeImageDescription(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}
