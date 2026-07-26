const REFERENCE_HEADING_PATTERN = /^(?:(#{1,6})[ \t]+)?(?:\*{1,2}|_{1,2})?(?:references?|bibliography|works[ \t]+cited|literature[ \t]+cited|参考文献|参考资料|参考书目)(?:\*{1,2}|_{1,2})?[ \t]*[:：]?[ \t]*#*[ \t]*$/gim;
const MARKDOWN_HEADING_PATTERN = /^(#{1,6})[ \t]+.+$/gm;
const NUMBERED_REFERENCE_PATTERN = /^[ \t]*(?:[-*+][ \t]+)?(?:\[(\d{1,4})\]|(\d{1,4})[.)])[ \t]+/gm;
const YEAR_PATTERN = /(?:^|[^\d])((?:18|19|20)\d{2}[a-z]?)(?=$|[^\d])/i;
const UNICODE_SUPERSCRIPT_PATTERN = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s*(?:[,;，；]\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[-–—⁻]\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]+))*/g;
const UNICODE_SUPERSCRIPT_CHARACTERS = {
    '⁰': '0',
    '¹': '1',
    '²': '2',
    '³': '3',
    '⁴': '4',
    '⁵': '5',
    '⁶': '6',
    '⁷': '7',
    '⁸': '8',
    '⁹': '9',
    '⁻': '-',
};

export function analyzeMarkdownCitations(markdown) {
    const source = String(markdown || '');
    const section = findReferenceSection(source);
    if (!section) return { references: [], citations: [] };

    const references = parseReferences(source, section);
    const citations = [
        ...findNumericCitations(source, section.from, references),
        ...findAuthorYearCitations(source, section.from, references),
    ].sort((left, right) => left.from - right.from || left.to - right.to);

    return {
        references,
        citations: removeOverlappingCitations(citations),
    };
}

function findReferenceSection(markdown) {
    const headingPattern = new RegExp(REFERENCE_HEADING_PATTERN);
    const match = [...markdown.matchAll(headingPattern)].at(-1);
    if (!match) return null;

    const level = match[1]?.length || 6;
    let from = match.index + match[0].length;
    if (markdown[from] === '\r') from++;
    if (markdown[from] === '\n') from++;
    let to = markdown.length;
    const followingHeadings = new RegExp(MARKDOWN_HEADING_PATTERN);
    followingHeadings.lastIndex = from;
    for (let heading = followingHeadings.exec(markdown); heading; heading = followingHeadings.exec(markdown)) {
        if (heading[1].length <= level) {
            to = heading.index;
            break;
        }
    }
    return { from, to };
}

function parseReferences(markdown, section) {
    const source = markdown.slice(section.from, section.to);
    const markerPattern = new RegExp(NUMBERED_REFERENCE_PATTERN);
    const markers = [...source.matchAll(markerPattern)];
    if (markers.length) {
        return markers.map((marker, index) => {
            const number = Number(marker[1] || marker[2]);
            const from = section.from + marker.index;
            const contentFrom = from + marker[0].length;
            const rawTo = index + 1 < markers.length
                ? section.from + markers[index + 1].index
                : section.to;
            const to = trimRangeEnd(markdown, contentFrom, rawTo);
            return createReference({
                id: `number:${number}`,
                number,
                text: plainReferenceText(markdown.slice(contentFrom, to)),
                from,
                to,
            });
        }).filter(reference => reference.text);
    }

    return unnumberedReferenceRanges(markdown, section)
        .map(({ from, to }, index) => createReference({
            id: `reference:${index + 1}`,
            number: null,
            text: plainReferenceText(markdown.slice(from, to)),
            from,
            to,
        }))
        .filter(reference => reference.text && reference.year);
}

function unnumberedReferenceRanges(markdown, section) {
    const paragraphs = paragraphRanges(markdown, section);
    if (paragraphs.length !== 1) return paragraphs;

    const source = markdown.slice(section.from, section.to);
    const linePattern = /^[ \t]*(?:[-*+][ \t]+)?(?=\p{L})[^\r\n]*(?:18|19|20)\d{2}[a-z]?[^\r\n]*$/gimu;
    const starts = [...source.matchAll(linePattern)];
    if (starts.length < 2) return paragraphs;

    return starts.map((start, index) => {
        let from = section.from + start.index;
        const leading = /^[ \t]*/.exec(markdown.slice(from))?.[0].length || 0;
        from += leading;
        const bullet = /^(?:[-*+][ \t]+)/.exec(markdown.slice(from))?.[0] || '';
        from += bullet.length;
        const rawTo = index + 1 < starts.length
            ? section.from + starts[index + 1].index
            : section.to;
        return { from, to: trimRangeEnd(markdown, from, rawTo) };
    });
}

function paragraphRanges(markdown, section) {
    const source = markdown.slice(section.from, section.to);
    const ranges = [];
    const blockPattern = /\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/g;
    for (const match of source.matchAll(blockPattern)) {
        const leading = /^\s*/.exec(match[0])?.[0].length || 0;
        let from = section.from + match.index + leading;
        const bullet = /^(?:[-*+][ \t]+)/.exec(markdown.slice(from))?.[0] || '';
        from += bullet.length;
        const to = trimRangeEnd(
            markdown,
            from,
            section.from + match.index + match[0].length
        );
        if (from < to) ranges.push({ from, to });
    }
    return ranges;
}

function createReference({ id, number, text, from, to }) {
    const year = extractYear(text);
    return {
        id,
        number,
        text,
        from,
        to,
        year,
        authorSearchText: normalizeSearchText(referenceAuthorText(text, year)),
    };
}

function findNumericCitations(markdown, bodyEnd, references) {
    const byNumber = new Map(
        references
            .filter(reference => Number.isInteger(reference.number))
            .map(reference => [reference.number, reference])
    );
    if (!byNumber.size) return [];

    const citations = [];
    const body = markdown.slice(0, bodyEnd);
    const containers = [
        { pattern: /\[([^\]\r\n]{1,80})\]/g, markdownLink: true },
        { pattern: /\(([^()\r\n]{1,80})\)/g, markdownLink: false },
        { pattern: /（([^（）\r\n]{1,80})）/g, markdownLink: false },
    ];
    for (const { pattern, markdownLink } of containers) {
        for (const match of body.matchAll(pattern)) {
            const after = body[match.index + match[0].length] || '';
            const before = body[match.index - 1] || '';
            if (markdownLink
                && (before === '!' || ['(', '[', ':'].includes(after))) {
                continue;
            }
            citations.push(...numericCitationsInContainer(match, byNumber));
        }
    }
    const superscriptPatterns = [
        /<sup(?:\s[^>]*)?>([^<>\r\n]{1,80})<\/sup\s*>/gi,
        /\$(?:\{\})?\^\{\s*(\d+(?:\s*(?:[,;，；]\s*\d+|[-–—]\s*\d+))*)\s*\}\$/g,
        /\\\((?:\{\})?\^\{\s*(\d+(?:\s*(?:[,;，；]\s*\d+|[-–—]\s*\d+))*)\s*\}\\\)/g,
    ];
    for (const pattern of superscriptPatterns) {
        for (const match of body.matchAll(pattern)) {
            if (superscriptIsLikelyExponent(body, match.index, match[1])) {
                continue;
            }
            const contentFrom = match.index + match[0].indexOf(match[1]);
            const contentTo = contentFrom + match[1].length;
            citations.push(...numericCitationsInText(
                match[1],
                contentFrom,
                byNumber,
                {
                    wrapperFrom: match.index,
                    contentFrom,
                    contentTo,
                    wrapperTo: match.index + match[0].length,
                    raiseContent: true,
                }
            ));
        }
    }
    for (const match of body.matchAll(UNICODE_SUPERSCRIPT_PATTERN)) {
        const after = body[match.index + match[0].length] || '';
        const normalized = [...match[0]]
            .map(character => UNICODE_SUPERSCRIPT_CHARACTERS[character] || character)
            .join('');
        if (/^[\p{L}\p{N}_]$/u.test(after)
            || superscriptIsLikelyExponent(body, match.index, normalized)) {
            continue;
        }
        citations.push(...numericCitationsInText(
            normalized,
            match.index,
            byNumber,
            {
                wrapperFrom: match.index,
                contentFrom: match.index,
                contentTo: match.index + match[0].length,
                wrapperTo: match.index + match[0].length,
                raiseContent: false,
            }
        ));
    }
    return citations;
}

function superscriptIsLikelyExponent(body, from, value) {
    if (!/^\s*\d+\s*$/.test(value)) return false;
    const preceding = body.slice(0, from);
    if (/\d\s*$/u.test(preceding)) return true;
    const base = /([\p{L}_][\p{L}\p{N}_]*)\s*$/u.exec(preceding)?.[1] || '';
    return base.length > 0 && base.length <= 2;
}

function numericCitationsInContainer(match, byNumber) {
    return numericCitationsInText(match[1], match.index + 1, byNumber);
}

function numericCitationsInText(value, valueFrom, byNumber, superscriptMarkup = null) {
    if (!/^\s*\d+(?:\s*(?:[,;，；]\s*\d+|[-–—]\s*\d+))*\s*$/.test(value)) {
        return [];
    }
    const citations = [];
    for (const segment of value.matchAll(/[^,;，；]+/g)) {
        const raw = segment[0];
        const leading = /^\s*/.exec(raw)?.[0].length || 0;
        const label = raw.trim();
        const from = valueFrom + segment.index + leading;
        const to = from + label.length;
        const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(label);
        if (range) {
            const first = Number(range[1]);
            const last = Number(range[2]);
            if (last < first || last - first > 100) continue;
            const matched = [];
            for (let number = first; number <= last; number++) {
                const reference = byNumber.get(number);
                if (reference) matched.push(reference);
            }
            if (matched.length) {
                citations.push(createCitation(
                    from,
                    to,
                    matched,
                    superscriptMarkup
                ));
            }
            continue;
        }
        const reference = byNumber.get(Number(label));
        if (reference) {
            citations.push(createCitation(
                from,
                to,
                [reference],
                superscriptMarkup
            ));
        }
    }
    return citations;
}

function findAuthorYearCitations(markdown, bodyEnd, references) {
    const body = markdown.slice(0, bodyEnd);
    const citations = [];
    const referencesByYear = groupReferencesByYear(references);
    const parentheticalPattern = /[（(]([^()（）\r\n]{1,240})[)）]/g;
    for (const match of body.matchAll(parentheticalPattern)) {
        const matched = [];
        for (const segment of match[1].split(/[;；]/)) {
            const authorYear = parseAuthorYearSegment(segment);
            if (!authorYear) continue;
            for (const year of authorYear.years) {
                matched.push(...matchAuthorReferences(
                    referencesByYear,
                    authorYear.authors,
                    year
                ));
            }
        }
        const unique = uniqueReferences(matched);
        if (unique.length) {
            citations.push(createCitation(
                match.index,
                match.index + match[0].length,
                unique
            ));
        }
    }

    const narrativePattern = /(^|[^\p{L}\p{N}_])([\p{L}][\p{L}'’.-]*(?:\s+et\s+al\.?|\s+(?:&|and)\s+[\p{L}][\p{L}'’.-]*)?)\s*[（(]([^()（）\r\n]{1,120})[)）]/giu;
    for (const match of body.matchAll(narrativePattern)) {
        const years = parseYearSequence(match[3]);
        const matched = uniqueReferences(years.flatMap(year => (
            matchAuthorReferences(referencesByYear, match[2], year)
        )));
        if (!matched.length) continue;
        const from = match.index + match[1].length;
        citations.push(createCitation(from, match.index + match[0].length, matched));
    }
    return citations;
}

function parseAuthorYearSegment(segment) {
    const value = segment.trim();
    const firstYear = /(?:18|19|20)\d{2}[a-z]?/i.exec(value);
    if (!firstYear) return null;
    const authors = value
        .slice(0, firstYear.index)
        .replace(/[\s,，]+$/u, '')
        .trim();
    if (!/\p{L}/u.test(authors)) return null;
    const years = parseYearSequence(value.slice(firstYear.index));
    return years.length ? { authors, years } : null;
}

function parseYearSequence(value) {
    const years = [];
    let remaining = String(value);
    let match = /^\s*((?:18|19|20)\d{2}[a-z]?)/i.exec(remaining);
    if (!match) return years;
    years.push(match[1].toLowerCase());
    remaining = remaining.slice(match[0].length);

    while ((match = /^\s*[,，]\s*((?:18|19|20)\d{2}[a-z]?)/i.exec(remaining))) {
        years.push(match[1].toLowerCase());
        remaining = remaining.slice(match[0].length);
    }
    return years;
}

function groupReferencesByYear(references) {
    const result = new Map();
    for (const reference of references) {
        if (!reference.year) continue;
        const sameYear = result.get(reference.year) || [];
        sameYear.push(reference);
        result.set(reference.year, sameYear);
    }
    return result;
}

function matchAuthorReferences(referencesByYear, authors, year) {
    const keys = normalizeAuthorKeys(authors);
    if (!keys.length) return [];
    const normalizedYear = String(year).toLowerCase();
    return (referencesByYear.get(normalizedYear) || []).filter(reference => {
        const searchable = ` ${reference.authorSearchText} `;
        return keys.every(key => searchable.includes(` ${key} `));
    });
}

function normalizeAuthorKeys(authors) {
    return String(authors)
        .replace(/^\s*(?:see|cf\.|e\.g\.,?)\s+/i, '')
        .replace(/\bet\s+al\.?/giu, '')
        .replace(/\band\b/giu, '&')
        .split(/\s*(?:[,，]|[&＆])\s*/u)
        .map(normalizeSearchText)
        .filter(key => /\p{L}/u.test(key));
}

function normalizeSearchText(value) {
    return String(value)
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function createCitation(from, to, references, superscriptMarkup = null) {
    const unique = uniqueReferences(references);
    const citation = {
        from,
        to,
        referenceIds: unique.map(reference => reference.id),
        references: unique,
    };
    if (superscriptMarkup) citation.superscriptMarkup = superscriptMarkup;
    return citation;
}

function uniqueReferences(references) {
    return [...new Map(references.map(reference => [reference.id, reference])).values()];
}

function removeOverlappingCitations(citations) {
    const result = [];
    for (const citation of citations) {
        const previous = result.at(-1);
        if (previous && previous.to > citation.from) continue;
        result.push(citation);
    }
    return result;
}

function extractYear(text) {
    return YEAR_PATTERN.exec(text)?.[1].toLowerCase() || '';
}

function referenceAuthorText(text, year) {
    if (!year) return '';
    const escapedYear = year.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parentheticalYear = new RegExp(`[（(]\\s*${escapedYear}\\s*[)）]`, 'i')
        .exec(text);
    if (parentheticalYear) return text.slice(0, parentheticalYear.index);
    const sentenceEnd = /[.。]\s+(?=\p{L})/u.exec(text);
    if (sentenceEnd) return text.slice(0, sentenceEnd.index);
    const yearIndex = text.toLowerCase().indexOf(year);
    return yearIndex < 0 ? text : text.slice(0, yearIndex);
}

function trimRangeEnd(markdown, from, to) {
    while (to > from && /\s/.test(markdown[to - 1])) to--;
    return to;
}

function plainReferenceText(source) {
    return String(source)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<((?:https?:\/\/|doi:)[^>]+)>/gi, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[`*_~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
