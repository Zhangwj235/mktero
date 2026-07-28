const ACADEMIC_FIGURE_CAPTION_PATTERN = /^((?:(?:algorithm|chart|fig\.?|figure|scheme|table)[ \t]+(?:s?\d+[a-z]?|[ivxlcdm]+[a-z]?)[.:]|fig\.[ \t]+(?:s?\d+[a-z]?|[ivxlcdm]+[a-z]?)))[ \t]+(\S[\s\S]*)$/iu;
const EMPTY_IMAGE_LINE_PATTERN = /^( {0,3})!\[[ \t]*\](\([^\r\n]+\))[ \t]*(?:\r?\n)?$/;
const MARKDOWN_IMAGE_LINE_PATTERN = /^ {0,3}!\[[^\]\r\n]*\]\([^\r\n]+\)[ \t]*(?:\r?\n)?$/;
const BLANK_LINE_PATTERN = /^[ \t]*(?:\r?\n)?$/;

export function parseAcademicFigureCaption(value) {
    const text = String(value || '').trim();
    const match = ACADEMIC_FIGURE_CAPTION_PATTERN.exec(text);
    if (!match) return null;
    return {
        text,
        label: match[1],
        description: match[2],
    };
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

        const precedingCaption = isIndentedCodeLine(lines[index])
            ? null
            : parseCaptionLine(lines[index]);
        if (precedingCaption) {
            let imageIndex = index + 1;
            if (BLANK_LINE_PATTERN.test(lines[imageIndex] || '')) {
                imageIndex++;
            }
            const imageLine = lines[imageIndex];
            const image = EMPTY_IMAGE_LINE_PATTERN.exec(imageLine || '');
            if (image && !nextNearbyLineIsImage(lines, imageIndex)) {
                output.push(formatCaptionedImage(
                    image,
                    precedingCaption.text,
                    lineEnding(imageLine)
                ));
                index = imageIndex;
                continue;
            }
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
        const captionEnding = lineEnding(captionLine);
        const caption = parseCaptionLine(captionLine);
        if (!caption) {
            output.push(lines[index]);
            continue;
        }

        output.push(formatCaptionedImage(image, caption.text, captionEnding));
        index = captionIndex;
    }

    return output.join('');
}

export function findAcademicFigureGroups(markdown) {
    const source = String(markdown || '');
    const lines = markdownLineRecords(source);
    const blockedLines = findBlockedLines(lines);
    const groups = [];

    for (let index = 0; index < lines.length; index++) {
        if (blockedLines.has(index)) continue;

        const caption = parseCaptionLine(lines[index].raw);
        if (caption) {
            const images = collectNearbyImages(lines, index + 1, blockedLines);
            if (images.length > 1) {
                groups.push({
                    from: lines[index].from,
                    to: lines[images.at(-1).index].to,
                    caption,
                    images,
                });
                index = images.at(-1).index;
                continue;
            }
        }

        if (!isMarkdownImageLine(lines[index].raw)) continue;
        const images = collectNearbyImages(lines, index, blockedLines);
        if (images.length < 2) continue;

        const captionIndex = nearbyLineIndex(lines, images.at(-1).index + 1);
        if (captionIndex >= lines.length || blockedLines.has(captionIndex)) continue;
        const trailingCaption = parseCaptionLine(lines[captionIndex].raw);
        if (!trailingCaption) continue;

        groups.push({
            from: lines[index].from,
            to: lines[captionIndex].to,
            caption: trailingCaption,
            images,
        });
        index = captionIndex;
    }

    return groups;
}

function markdownLineRecords(markdown) {
    const rawLines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const lines = [];
    let offset = 0;
    for (const raw of rawLines) {
        const ending = lineEnding(raw);
        const text = raw.slice(0, raw.length - ending.length);
        lines.push({
            raw,
            text,
            from: offset,
            to: offset + text.length,
        });
        offset += raw.length;
    }
    return lines;
}

function findBlockedLines(lines) {
    const blocked = new Set();
    let activeFence = null;
    for (const [index, line] of lines.entries()) {
        const fence = markdownFence(line.raw);
        if (activeFence) {
            blocked.add(index);
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
            blocked.add(index);
            continue;
        }
        if (isIndentedCodeLine(line.raw)) blocked.add(index);
    }
    return blocked;
}

function collectNearbyImages(lines, startIndex, blockedLines) {
    const images = [];
    let index = nearbyLineIndex(lines, startIndex);
    while (index < lines.length
        && !blockedLines.has(index)
        && isMarkdownImageLine(lines[index].raw)) {
        images.push({
            index,
            source: lines[index].text.trim(),
        });
        const nextIndex = nearbyLineIndex(lines, index + 1);
        if (nextIndex <= index) break;
        index = nextIndex;
    }
    return images;
}

function nearbyLineIndex(lines, index) {
    return index < lines.length && BLANK_LINE_PATTERN.test(lines[index].raw)
        ? index + 1
        : index;
}

function isMarkdownImageLine(line) {
    return MARKDOWN_IMAGE_LINE_PATTERN.test(line || '');
}

function previousNearbyLineIsImage(lines, index) {
    let previousIndex = index - 1;
    if (BLANK_LINE_PATTERN.test(lines[previousIndex] || '')) previousIndex--;
    return MARKDOWN_IMAGE_LINE_PATTERN.test(lines[previousIndex] || '');
}

function nextNearbyLineIsImage(lines, index) {
    let nextIndex = index + 1;
    if (BLANK_LINE_PATTERN.test(lines[nextIndex] || '')) nextIndex++;
    return MARKDOWN_IMAGE_LINE_PATTERN.test(lines[nextIndex] || '');
}

function parseCaptionLine(line) {
    const source = String(line || '');
    const ending = lineEnding(source);
    return parseAcademicFigureCaption(
        source.slice(0, source.length - ending.length)
    );
}

function isIndentedCodeLine(line) {
    return /^(?: {4}|\t)/.test(line || '');
}

function lineEnding(line) {
    return /\r?\n$/.exec(line || '')?.[0] || '';
}

function formatCaptionedImage(image, caption, ending) {
    return `${image[1]}![${escapeImageDescription(caption)}]`
        + `${image[2]}${ending}`;
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
