import { createMarkdownSourceMap } from '../core/markdown-source-map.js';
import { reassembleMinerUFigurePanels } from './figure-panel-normalizer.js';
import { normalizeMinerUMarkdown } from './markdown-normalizer.js';
import { reassembleMinerUTextFlow } from './text-flow-normalizer.js';

export function prepareMinerUResult(result) {
    const {
        contentList,
        sourceMap: existingSourceMap,
        ...prepared
    } = result || {};
    if (prepared.userEdited) return prepared;

    let markdown = normalizeMinerUMarkdown(prepared.markdown);
    let sourceMap = existingSourceMap;
    if (!Array.isArray(sourceMap) && Array.isArray(contentList)) {
        const initialSourceMap = createMarkdownSourceMap(markdown, contentList);
        if (typeof markdown === 'string') {
            const flowedMarkdown = reassembleMinerUTextFlow(
                markdown,
                initialSourceMap
            );
            const textFlowChanged = flowedMarkdown !== markdown;
            const flowedSourceMap = textFlowChanged
                ? createMarkdownSourceMap(flowedMarkdown, contentList, {
                    includeMatchedTextRanges: true,
                })
                : initialSourceMap;
            const reassembled = reassembleMinerUFigurePanels(
                flowedMarkdown,
                flowedSourceMap
            );
            sourceMap = reassembled === flowedMarkdown
                ? flowedSourceMap
                : createMarkdownSourceMap(reassembled, contentList, {
                    includeMatchedTextRanges: textFlowChanged,
                });
            markdown = reassembled;
        }
        else {
            sourceMap = initialSourceMap;
        }
    }
    return {
        ...prepared,
        markdown,
        ...(sourceMap ? { sourceMap } : {}),
    };
}
