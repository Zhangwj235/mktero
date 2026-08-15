import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createDehyphenatedPdfAnnotationTextIndex,
    createHyphenPreservingPdfAnnotationTextIndex,
    createPdfAnnotationTextIndex,
    normalizePdfAnnotationText,
} from '../src/markdown/pdf-annotation-text.js';

test('normalizes mathematical operator whitespace while preserving source ranges', () => {
    const markdown = 'Results (p<0.001), (r=0.563), from −3 to +2, ±2.';
    const pdf = 'Results (p < 0.001), (r = 0.563), from − 3 to + 2, ± 2.';
    const index = createPdfAnnotationTextIndex(pdf);
    const normalized = normalizePdfAnnotationText(pdf);
    const target = 'p<0.001';
    const from = index.text.indexOf(target);
    const range = index.sourceRange(from, target.length);

    assert.equal(normalizePdfAnnotationText(markdown), normalized);
    assert.equal(normalized, 'Results (p<0.001), (r=0.563), from -3 to +2, ±2.');
    assert.equal(pdf.slice(range.from, range.to), 'p < 0.001');
    assert.equal(normalizePdfAnnotationText('well - being'), 'well - being');
});

test('normalizes signed-number spacing after opening delimiters', () => {
    const source = 'Limits ( \t± 2 days), range [ + 3 ], set { − 4 }, '
        + 'LaTeX ( \\pm 5 days).';
    const index = createPdfAnnotationTextIndex(source);
    const normalized = 'Limits (±2 days), range [+3 ], set {-4 }, '
        + 'LaTeX (±5 days).';

    assert.equal(index.text, normalized);
    const target = '(±2 days)';
    const range = index.sourceRange(
        normalized.indexOf(target),
        target.length
    );
    assert.equal(source.slice(range.from, range.to), '( \t± 2 days)');
    assert.equal(normalizePdfAnnotationText('( ± value)'), '( ± value)');
    assert.equal(normalizePdfAnnotationText('( example)'), '( example)');
    assert.equal(normalizePdfAnnotationText('( \\pm value)'), '( ± value)');
});

test('handles repeated oversized signed-number spacing', () => {
    const fragment = `( ${' '.repeat(256)}± ${' '.repeat(256)}2)`;
    const source = Array(512).fill(fragment).join(' ');
    const expected = Array(512).fill('(±2)').join(' ');

    assert.equal(normalizePdfAnnotationText(source), expected);
});

test('normalizes PDF.js spacing around degree units while preserving source ranges', () => {
    const markdown = 'Basal body temperature increases by 0.3 °C.';
    const pdf = 'Basal body temperature increases by 0.3   ° C.';
    const markdownIndex = createPdfAnnotationTextIndex(markdown);
    const pdfIndex = createPdfAnnotationTextIndex(pdf);

    assert.equal(pdfIndex.text, markdownIndex.text);
    assert.equal(
        pdfIndex.text,
        'Basal body temperature increases by 0.3°C.'
    );

    const target = '0.3°C';
    const range = pdfIndex.sourceRange(
        pdfIndex.text.indexOf(target),
        target.length
    );
    assert.equal(pdf.slice(range.from, range.to), '0.3   ° C');
});

test('limits misencoded degree recovery to standalone temperature units', () => {
    assert.equal(
        normalizePdfAnnotationText('Thresholds 0.2\uFFFDC and 1\uFFFDF.'),
        'Thresholds 0.2°C and 1°F.'
    );
    assert.equal(
        normalizePdfAnnotationText(
            'Unrelated A\uFFFDC, 0.2\uFFFDK, 0.2\uFFFDCase, 0.2\uFFFDC2.'
        ),
        'Unrelated A\uFFFDC, 0.2\uFFFDK, 0.2\uFFFDCase, 0.2\uFFFDC2.'
    );
});

test('normalizes MinerU LaTeX symbols while preserving source ranges', () => {
    const markdown = 'Difference 0.30\\;^{\\circ}\\mathrm{C}; window \\pm2.';
    const pdf = 'Difference 0.30 °C; window ± 2.';
    const markdownIndex = createPdfAnnotationTextIndex(markdown);
    const pdfIndex = createPdfAnnotationTextIndex(pdf);
    const normalized = 'Difference 0.30°C; window ±2.';

    assert.equal(markdownIndex.text, normalized);
    assert.equal(pdfIndex.text, normalized);

    const degree = '0.30°C';
    const markdownDegreeRange = markdownIndex.sourceRange(
        normalized.indexOf(degree),
        degree.length
    );
    const pdfDegreeRange = pdfIndex.sourceRange(
        normalized.indexOf(degree),
        degree.length
    );
    assert.equal(
        markdown.slice(markdownDegreeRange.from, markdownDegreeRange.to),
        '0.30\\;^{\\circ}\\mathrm{C}'
    );
    assert.equal(
        pdf.slice(pdfDegreeRange.from, pdfDegreeRange.to),
        '0.30 °C'
    );

    const plusMinus = '±2';
    const plusMinusRange = markdownIndex.sourceRange(
        normalized.indexOf(plusMinus),
        plusMinus.length
    );
    assert.equal(
        markdown.slice(plusMinusRange.from, plusMinusRange.to),
        '\\pm2'
    );
    assert.equal(normalizePdfAnnotationText('\\pmod2'), '\\pmod2');
});

test('normalizes LaTeX relational operators while preserving source ranges', () => {
    const markdown = 'Limits x \\geq 2, y \\le 3, z \\neq 4.';
    const pdf = 'Limits x >= 2, y <= 3, z != 4.';
    const index = createPdfAnnotationTextIndex(markdown);
    const pdfIndex = createPdfAnnotationTextIndex(pdf);
    const normalized = 'Limits x≥2, y≤3, z≠4.';

    assert.equal(index.text, normalized);
    assert.equal(pdfIndex.text, normalized);
    assert.equal(
        normalizePdfAnnotationText('Limits x ≥ 2, y ≤ 3, z ≠ 4.'),
        normalized
    );
    const target = 'x≥2';
    const range = index.sourceRange(
        normalized.indexOf(target),
        target.length
    );
    const pdfRange = pdfIndex.sourceRange(
        normalized.indexOf(target),
        target.length
    );
    assert.equal(markdown.slice(range.from, range.to), 'x \\geq 2');
    assert.equal(pdf.slice(pdfRange.from, pdfRange.to), 'x >= 2');
    assert.equal(
        normalizePdfAnnotationText('x \\ge 2, y \\leq 3, z \\ne 4'),
        'x≥2, y≤3, z≠4'
    );
});

test('normalizes relational operators after opening delimiters', () => {
    const markdown = 'PA encompasses any body movement that results in energy '
        + 'expenditure ( \\geq 1.5 MET).';
    const pdf = 'PA encompasses any body movement that results in energy '
        + 'expenditure (≥\u20091.5 MET).';
    const markdownIndex = createPdfAnnotationTextIndex(markdown);
    const pdfIndex = createPdfAnnotationTextIndex(pdf);
    const normalized = 'PA encompasses any body movement that results in '
        + 'energy expenditure (≥1.5 MET).';

    assert.equal(markdownIndex.text, normalized);
    assert.equal(pdfIndex.text, normalized);

    const target = '(≥1.5 MET)';
    const markdownRange = markdownIndex.sourceRange(
        normalized.indexOf(target),
        target.length
    );
    const pdfRange = pdfIndex.sourceRange(
        normalized.indexOf(target),
        target.length
    );
    assert.equal(
        markdown.slice(markdownRange.from, markdownRange.to),
        '( \\geq 1.5 MET)'
    );
    assert.equal(
        pdf.slice(pdfRange.from, pdfRange.to),
        '(≥\u20091.5 MET)'
    );
    assert.equal(normalizePdfAnnotationText('( example)'), '( example)');
    assert.equal(normalizePdfAnnotationText('( \\\\geq 1.5)'), '( \\\\geq 1.5)');
    assert.equal(normalizePdfAnnotationText('( \\geqslant 1.5)'), '( \\geqslant 1.5)');
});

test('normalizes LaTeX temperature units from saved Markdown annotations', () => {
    const markdown = 'Temperature increased by 0.3^{\\circ}\\mathrm{C}.';
    const pdf = 'Temperature increased by 0.3 °C.';
    const markdownIndex = createPdfAnnotationTextIndex(markdown);
    const pdfIndex = createPdfAnnotationTextIndex(pdf);

    assert.equal(markdownIndex.text, 'Temperature increased by 0.3°C.');
    assert.equal(markdownIndex.text, pdfIndex.text);
    const range = markdownIndex.sourceRange(
        markdownIndex.text.indexOf('0.3°C'),
        '0.3°C'.length
    );
    assert.equal(
        markdown.slice(range.from, range.to),
        '0.3^{\\circ}\\mathrm{C}'
    );
});

test('normalizes statistical exponents before relational operators', () => {
    const markdown = 'The fitted model reports R^{2}=0.99.';
    const pdf = 'The fitted model reports R2 = 0.99.';
    const index = createPdfAnnotationTextIndex(markdown);
    const normalized = normalizePdfAnnotationText(markdown);

    assert.equal(normalized, normalizePdfAnnotationText(pdf));
    assert.equal(normalized, 'The fitted model reports R2=0.99.');
    const target = 'R2';
    const range = index.sourceRange(
        normalized.indexOf(target),
        target.length
    );
    assert.equal(markdown.slice(range.from, range.to), 'R^{2}');
    assert.equal(normalizePdfAnnotationText('x^{2}.'), 'x^{2}.');
    assert.equal(
        normalizePdfAnnotationText('R^{12345}=1'),
        'R^{12345}=1'
    );
});

test('leaves escaped, malformed, and oversized LaTeX-like input unchanged', () => {
    const fragment = '\\\\pm 2 ( \\\\pm 3) 0.30\\\\;^{\\circ}C '
        + '\\\\geq 2 \\geqslant 3 \\leqmatrix \\neqalign '
        + '\\pmod2 \\pmatrix '
        + '\\input{secret} 0.30\\;^{\\cir';
    const source = Array(1_000).fill(fragment).join(' ');

    assert.equal(normalizePdfAnnotationText(source), source);
});

test('maps PDF line-end hyphens back to their original source range', () => {
    const source = '😀 Words were inves-\ntigated and evidence-based.';
    const index = createDehyphenatedPdfAnnotationTextIndex(source);
    const target = 'investigated';
    const from = index.text.indexOf(target);
    const range = index.sourceRange(from, target.length);

    assert.equal(
        index.text,
        '😀 Words were investigated and evidence-based.'
    );
    assert.equal(source.slice(range.from, range.to), 'inves-\ntigated');
});

test('preserves lexical hyphens without following whitespace', () => {
    const index = createDehyphenatedPdfAnnotationTextIndex(
        'evidence-based and well- being'
    );

    assert.equal(index.text, 'evidence-based and wellbeing');
});

test('preserves a lexical hyphen split across a PDF line', () => {
    const source = 'According to these authors 16, state-\nspace models.';
    const index = createHyphenPreservingPdfAnnotationTextIndex(source);
    const target = 'state-space';
    const from = index.text.indexOf(target);
    const range = index.sourceRange(from, target.length);

    assert.equal(
        index.text,
        'According to these authors 16, state-space models.'
    );
    assert.equal(source.slice(range.from, range.to), 'state-\nspace');
});
