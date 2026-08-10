// Reconstructs a Markdown string that combines the original source with the
// translated segments produced by the immersive translation feature.
//
// Translation segments carry character offsets (`from`/`to`) into the original
// `model.markdown` and a `text` field holding the translation. When the viewer
// shows translations it inserts the Chinese widget after each English block, so
// the bilingual output below mirrors that layout: original English, then the
// Chinese translation, for every completed segment.

export function buildBilingualMarkdown(source, translation) {
    const markdown = String(source ?? '');
    const segments = Array.isArray(translation?.segments)
        ? translation.segments
        : [];
    const completed = segments
        .filter(segment => segment?.status === 'complete'
            && Number.isInteger(segment.from)
            && Number.isInteger(segment.to)
            && segment.from >= 0
            && segment.to <= markdown.length
            && segment.from <= segment.to)
        .sort((left, right) => left.from - right.from);
    if (!completed.length) return markdown;

    const parts = [];
    let cursor = 0;
    for (const segment of completed) {
        // Defensively skip overlaps; segments are non-overlapping by design.
        if (segment.from < cursor) continue;
        if (segment.from > cursor) {
            parts.push(markdown.slice(cursor, segment.from));
        }
        parts.push(markdown.slice(segment.from, segment.to));
        const translated = String(segment.text ?? '').trim();
        if (translated) {
            parts.push('\n\n');
            parts.push(translated);
        }
        cursor = segment.to;
    }
    if (cursor < markdown.length) {
        parts.push(markdown.slice(cursor));
    }
    return parts.join('');
}
