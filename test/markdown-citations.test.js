import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkdownCitations } from '../src/markdown/markdown-citations.js';

test('maps numeric citation tags and ranges to numbered references', () => {
    const markdown = [
        '# Paper',
        '',
        'First result [1], comparison [2, 3], and review [4–5].',
        '',
        '## References',
        '',
        '[1] Alpha A. First paper. 2020.',
        '[2] Beta B. Second paper. 2021.',
        '[3] Gamma G. Third paper. 2022.',
        '[4] Delta D. Fourth paper. 2023.',
        '[5] Epsilon E. Fifth paper. 2024.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.references.map(reference => ({
            id: reference.id,
            number: reference.number,
            text: reference.text,
        })),
        [
            { id: 'number:1', number: 1, text: 'Alpha A. First paper. 2020.' },
            { id: 'number:2', number: 2, text: 'Beta B. Second paper. 2021.' },
            { id: 'number:3', number: 3, text: 'Gamma G. Third paper. 2022.' },
            { id: 'number:4', number: 4, text: 'Delta D. Fourth paper. 2023.' },
            { id: 'number:5', number: 5, text: 'Epsilon E. Fifth paper. 2024.' },
        ]
    );
    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            referenceIds: citation.referenceIds,
        })),
        [
            { label: '1', referenceIds: ['number:1'] },
            { label: '2', referenceIds: ['number:2'] },
            { label: '3', referenceIds: ['number:3'] },
            { label: '4–5', referenceIds: ['number:4', 'number:5'] },
        ]
    );
    assert.ok(result.references.every(reference => (
        markdown.slice(reference.from, reference.to).includes(reference.text)
    )));
});

test('maps HTML superscript citation numbers and ranges to references', () => {
    const markdown = [
        '# Paper',
        '',
        'Relaxation methods reduce anxiety<sup>2–4</sup>.',
        'Slow breathing improves awareness.<sup>6</sup>',
        'Surface area remains m<sup>2</sup>.',
        '',
        '## References',
        '',
        '[2] Beta B. Second paper. 2020.',
        '[3] Gamma G. Third paper. 2021.',
        '[4] Delta D. Fourth paper. 2022.',
        '[6] Zeta Z. Sixth paper. 2024.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            referenceIds: citation.referenceIds,
        })),
        [
            {
                label: '2–4',
                referenceIds: ['number:2', 'number:3', 'number:4'],
            },
            { label: '6', referenceIds: ['number:6'] },
        ]
    );
});

test('maps LaTeX superscript citation numbers and ranges to references', () => {
    const markdown = [
        '# Paper',
        '',
        'Relaxation methods reduce anxiety $^{2-4}$.',
        'Slow breathing improves awareness \\(^{6}\\).',
        'Surface area remains m$^{2}$.',
        '',
        '## References',
        '',
        '[2] Beta B. Second paper. 2020.',
        '[3] Gamma G. Third paper. 2021.',
        '[4] Delta D. Fourth paper. 2022.',
        '[6] Zeta Z. Sixth paper. 2024.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            referenceIds: citation.referenceIds,
        })),
        [
            {
                label: '2-4',
                referenceIds: ['number:2', 'number:3', 'number:4'],
            },
            { label: '6', referenceIds: ['number:6'] },
        ]
    );
});

test('maps Unicode superscript citations without treating exponents as references', () => {
    const markdown = [
        '# Paper',
        '',
        'Relaxation methods reduce anxiety²⁻⁴.',
        'Slow breathing improves awareness⁶, while area stays m².',
        '',
        '## References',
        '',
        '[2] Beta B. Second paper. 2020.',
        '[3] Gamma G. Third paper. 2021.',
        '[4] Delta D. Fourth paper. 2022.',
        '[6] Zeta Z. Sixth paper. 2024.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            referenceIds: citation.referenceIds,
        })),
        [
            {
                label: '²⁻⁴',
                referenceIds: ['number:2', 'number:3', 'number:4'],
            },
            { label: '⁶', referenceIds: ['number:6'] },
        ]
    );
});

test('prefers bracket citations over superscript footnotes in mixed papers', () => {
    const markdown = [
        '# Paper',
        '',
        '## Introduction',
        '',
        'A practitioner claim appears here $^{1}$ and another source follows. '
            + '$^{2}$',
        '',
        'ReAct $[50]$ formalized this agent cycle.',
        '',
        'A figure is introduced here $^{3}$ and discussed further $^{4}$.',
        '',
        'Other academic work supports the result $[20]$.',
        '',
        '## References',
        '',
        '[1] Alpha A. First academic paper. 2020.',
        '[2] Beta B. Second academic paper. 2021.',
        '[3] Gamma G. Third academic paper. 2022.',
        '[4] Delta D. Fourth academic paper. 2023.',
        '[20] Twenty T. Twentieth academic paper. 2024.',
        '[50] Yao, S. ReAct: Synergizing reasoning and acting. 2022.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            superscript: Boolean(citation.superscriptMarkup),
            targetIds: citation.referenceIds,
        })),
        [
            {
                label: '50',
                superscript: false,
                targetIds: ['number:50'],
            },
            {
                label: '20',
                superscript: false,
                targetIds: ['number:20'],
            },
        ]
    );
});

test('keeps superscript references without multiple bracket citation positions', () => {
    const markdown = [
        '# Paper',
        '',
        'The primary source is cited here $^{1}$, with one isolated [2, 3].',
        '',
        '## References',
        '',
        '[1] Alpha A. First paper. 2020.',
        '[2] Beta B. Second paper. 2021.',
        '[3] Gamma G. Third paper. 2022.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            superscript: Boolean(citation.superscriptMarkup),
        })),
        [
            { label: '1', superscript: true },
            { label: '2', superscript: false },
            { label: '3', superscript: false },
        ]
    );
});

test('maps author superscripts to affiliations without stealing body references', () => {
    const markdown = [
        '# Acceptability of Artificial Intelligence Therapy',
        '',
        'Ashish Mehta $^{1}$, BA; Andrea Niles $^{2}$, PhD',
        '',
        '$^{1}$ Department of Psychology, Stanford University. '
            + '$^{2}$ Youper, Inc.',
        '',
        'Corresponding Author: Ashish Mehta',
        '',
        '## Abstract',
        '',
        'Prior work (Smith, 2020) supports this result $^{1}$.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
        '[2] Beta B. Another cited paper. 2021.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.affiliations.map(affiliation => ({
            id: affiliation.id,
            number: affiliation.number,
            text: affiliation.text,
        })),
        [
            {
                id: 'affiliation:1',
                number: 1,
                text: 'Department of Psychology, Stanford University.',
            },
            {
                id: 'affiliation:2',
                number: 2,
                text: 'Youper, Inc.',
            },
        ]
    );
    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            kind: citation.kind,
            targetIds: citation.referenceIds,
        })),
        [
            { label: '1', kind: 'affiliation', targetIds: ['affiliation:1'] },
            { label: '2', kind: 'affiliation', targetIds: ['affiliation:2'] },
            {
                label: '(Smith, 2020)',
                kind: 'reference',
                targetIds: ['number:1'],
            },
            { label: '1', kind: 'reference', targetIds: ['number:1'] },
        ]
    );
});

test('does not treat unmatched front-matter superscripts as references', () => {
    const markdown = [
        '# Paper',
        '',
        'Ashish Mehta<sup>1</sup>',
        '',
        '## Abstract',
        '',
        'The body contains a real citation<sup>1</sup>.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(result.affiliations, []);
    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            kind: citation.kind,
        })),
        [{ label: '1', kind: 'reference' }]
    );
});

test('recognizes affiliations before an unlisted body heading', () => {
    const markdown = [
        '# Paper',
        '',
        'Alice $^{1}$',
        '',
        '$^{1}$ Research Lab',
        '',
        '## Overview',
        '',
        'The body contains a real citation $^{1}$.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            kind: citation.kind,
        })),
        [
            { label: '1', kind: 'affiliation' },
            { label: '1', kind: 'reference' },
        ]
    );
});

test('keeps citations before a later recognized body heading', () => {
    const markdown = [
        '# Paper',
        '',
        'Alice $^{1}$',
        '',
        '$^{1}$ Research Lab',
        '',
        '## Related Work',
        '',
        'Prior work contains a real citation $^{1}$.',
        '',
        '## Methods',
        '',
        'Methods text.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => citation.kind),
        ['affiliation', 'reference']
    );
});

test('maps short author names without treating their markers as exponents', () => {
    const markdown = [
        '# Paper',
        '',
        'Li $^{1}$; Wu<sup>2</sup>',
        '',
        '$^{1}$ First Lab $^{2}$ Second Lab',
        '',
        '## 1. Introduction',
        '',
        'The body contains a real citation $^{1}$.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            kind: citation.kind,
            targetIds: citation.referenceIds,
        })),
        [
            {
                label: '1',
                kind: 'affiliation',
                targetIds: ['affiliation:1'],
            },
            {
                label: '2',
                kind: 'affiliation',
                targetIds: ['affiliation:2'],
            },
            {
                label: '1',
                kind: 'reference',
                targetIds: ['number:1'],
            },
        ]
    );
});

test('does not map a title exponent to an author affiliation', () => {
    const markdown = [
        '# Effect of x$^{2}$ on Therapy',
        '',
        'Li $^{1}$; Alice $^{2}$',
        '',
        '$^{1}$ First Lab $^{2}$ Second Lab',
        '',
        '## Abstract',
        '',
        'Body text.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
        '[2] Jones, B. (2021). Another cited paper.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => markdown.slice(
            citation.from,
            citation.to
        )),
        ['1', '2']
    );
});

test('skips front-matter headings before affiliation definitions', () => {
    const markdown = [
        '# Paper',
        '',
        '## Author Details',
        '',
        'Li $^{1}$',
        '',
        '## Institutions',
        '',
        '$^{1}$ Research Lab',
        '',
        '## Keywords',
        '',
        'therapy; research',
        '',
        '## Overview',
        '',
        'The body contains a real citation $^{1}$.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => citation.kind),
        ['affiliation', 'reference']
    );
});

test('infers the body after affiliations when no section heading exists', () => {
    const markdown = [
        '# Paper',
        '',
        'Li $^{1}$',
        '',
        '$^{1}$ Research Lab',
        '',
        'Body text contains a real citation $^{1}$.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => citation.kind),
        ['affiliation', 'reference']
    );
});

test('parses multiline HTML and Unicode affiliation definitions', () => {
    const markdown = [
        '# Paper',
        '',
        'Alice<sup>1</sup>; Beatrice<sup>2</sup>',
        '',
        '<sup>1</sup> First Research Lab,',
        'University A',
        '',
        '² Second Research Lab,',
        'University B',
        '',
        '## Abstract',
        '',
        'The body contains a real citation<sup>1</sup>.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.affiliations.map(affiliation => affiliation.text),
        [
            'First Research Lab, University A',
            'Second Research Lab, University B',
        ]
    );
    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            kind: citation.kind,
            targetIds: citation.referenceIds,
        })),
        [
            {
                label: '1',
                kind: 'affiliation',
                targetIds: ['affiliation:1'],
            },
            {
                label: '2',
                kind: 'affiliation',
                targetIds: ['affiliation:2'],
            },
            {
                label: '1',
                kind: 'reference',
                targetIds: ['number:1'],
            },
        ]
    );
});

test('matches parenthetical and narrative author-year citations', () => {
    const markdown = [
        '# Paper',
        '',
        'Training changes the brain (Münte, Altenmüller, & Jäncke, 2002).',
        'A later study by Smith et al. (2020) confirmed the result.',
        '',
        '## Bibliography',
        '',
        'Münte, T. F., Altenmüller, E., & Jäncke, L. (2002).',
        'The musician’s brain. Journal of Cognitive Neuroscience.',
        '',
        'Smith, A., Jones, B., & Lee, C. (2020). Follow-up study.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.equal(result.references.length, 2);
    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            text: citation.references.map(reference => reference.text),
        })),
        [
            {
                label: '(Münte, Altenmüller, & Jäncke, 2002)',
                text: [
                    'Münte, T. F., Altenmüller, E., & Jäncke, L. (2002). '
                        + 'The musician’s brain. Journal of Cognitive Neuroscience.',
                ],
            },
            {
                label: 'Smith et al. (2020)',
                text: ['Smith, A., Jones, B., & Lee, C. (2020). Follow-up study.'],
            },
        ]
    );
});

test('supports Chinese reference headings and numbered list entries', () => {
    const markdown = [
        '# 论文',
        '',
        '已有研究支持这一结论 [1]。',
        '',
        '## 参考文献',
        '',
        '1. 张三，李四。示例研究。2024。',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.equal(result.references[0].text, '张三，李四。示例研究。2024。');
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].references[0], result.references[0]);
});

test('parses a plain reference heading and line-separated author entries', () => {
    const markdown = [
        '# Paper',
        '',
        'Earlier reports agree (Smith, 2020; Jones, 2021).',
        '',
        '**References**',
        'Smith, A. (2020). First line-separated reference.',
        'Jones, B. (2021). Second line-separated reference.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.references.map(reference => reference.text),
        [
            'Smith, A. (2020). First line-separated reference.',
            'Jones, B. (2021). Second line-separated reference.',
        ]
    );
    assert.equal(result.citations.length, 1);
    assert.deepEqual(
        result.citations[0].referenceIds,
        ['reference:1', 'reference:2']
    );
});

test('supports common citation punctuation, locators, and full-width forms', () => {
    const markdown = [
        '# Paper',
        '',
        'Page locator (Smith, 2020, pp. 42–44), no comma (Jones 2021),',
        'full-width punctuation （张三，2024）, and numeric parentheses (1).',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). First reference.',
        '[2] Jones, B. (2021). Second reference.',
        '[3] 张三。（2024）。第三条参考文献。',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => markdown.slice(citation.from, citation.to)),
        [
            '(Smith, 2020, pp. 42–44)',
            '(Jones 2021)',
            '（张三，2024）',
            '1',
        ]
    );
    assert.deepEqual(
        result.citations.map(citation => citation.referenceIds),
        [
            ['number:1'],
            ['number:2'],
            ['number:3'],
            ['number:1'],
        ]
    );
});

test('matches narrative locators and multiple years by the same author', () => {
    const markdown = [
        '# Paper',
        '',
        'Smith (2020, p. 42) introduced the method.',
        'Later summaries agree (Smith, 2020, 2021).',
        'Lettered years stay distinct (Smith, 2020a, 2020b).',
        '',
        '## References',
        '',
        'Smith, A. (2020). Original method.',
        '',
        'Smith, A. (2021). Later summary.',
        '',
        'Smith, A. (2020a). First lettered result.',
        '',
        'Smith, A. (2020b). Second lettered result.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.deepEqual(
        result.citations.map(citation => ({
            label: markdown.slice(citation.from, citation.to),
            years: citation.references.map(reference => reference.year),
        })),
        [
            { label: 'Smith (2020, p. 42)', years: ['2020'] },
            { label: '(Smith, 2020, 2021)', years: ['2020', '2021'] },
            { label: '(Smith, 2020a, 2020b)', years: ['2020a', '2020b'] },
        ]
    );
});

test('matches author names only in the leading author field', () => {
    const markdown = [
        '# Paper',
        '',
        'The relevant result was reported earlier (Brown, 2020).',
        '',
        '## References',
        '',
        'Smith, A. (2020). Brown adipose tissue.',
        '',
        'Brown, B. (2020). Relevant result.',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].references.length, 1);
    assert.equal(result.citations[0].references[0].text, 'Brown, B. (2020). Relevant result.');
});

test('ignores unresolved tags, Markdown links, and numbers inside references', () => {
    const markdown = [
        '# Paper',
        '',
        'Unresolved [9], ordinary [website](https://example.com), and year (2024).',
        '',
        '## References',
        '',
        '[1] A reference mentioning [1] and (Author, 2020).',
    ].join('\n');

    const result = analyzeMarkdownCitations(markdown);

    assert.equal(result.references.length, 1);
    assert.deepEqual(result.citations, []);
});
