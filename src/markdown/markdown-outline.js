import { GFM, parser as markdownParser } from '@lezer/markdown';

const OUTLINE_PARSER = markdownParser.configure(GFM);
const HEADING_NODE = /^(?:ATXHeading|SetextHeading)([1-6])$/;

export function extractMarkdownOutline(markdown) {
    const source = String(markdown || '');
    const headings = [];
    OUTLINE_PARSER.parse(source).iterate({
        enter(node) {
            const match = HEADING_NODE.exec(node.name);
            if (!match) return;
            const text = visibleHeadingText(
                source.slice(node.from, node.to),
                node.name
            );
            if (!text) return;
            headings.push({
                level: Number(match[1]),
                text,
                offset: node.from,
            });
        },
    });
    return headings;
}

function visibleHeadingText(headingSource, nodeName) {
    let text = headingSource;
    if (nodeName.startsWith('ATXHeading')) {
        text = text
            .replace(/^ {0,3}#{1,6}[\t ]+/, '')
            .replace(/[\t ]+#+[\t ]*$/, '');
    }
    else {
        text = text.replace(/\n {0,3}(?:=+|-+)[\t ]*$/, '');
    }
    return text
        .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
        .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
        .replace(/(`+)(.*?)\1/g, '$2')
        .replace(
            /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s@]+)>/g,
            '$1'
        )
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/?[A-Za-z][^>]*>/g, '')
        .replace(/(^|[\s([{])[*_~]{1,3}(?=\S)/g, '$1')
        .replace(/[*_~]{1,3}(?=$|[\s)\]},.!?:;])/g, '')
        .replace(/\\([\\`*_[\]{}()#+.!<>~-])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}
