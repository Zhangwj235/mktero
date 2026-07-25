import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';

test('renders the Markdown subset used by the PDF converter', () => {
    const markdown = [
        '<!-- zotero-page: 2 -->',
        '',
        '# Intro',
        '',
        'A **bold** and *useful* paragraph.',
        '',
        '- First',
        '- Second',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| x | 1 |',
        '',
        '$$',
        'x^2 + y^2 = z^2',
        '$$',
    ].join('\n');

    const html = renderMarkdownHTML(markdown);
    assert.match(html, /<span class="page-marker" data-page="2">Page 2<\/span>/);
    assert.match(html, /<h1>Intro<\/h1>/);
    assert.match(html, /<p>A <strong>bold<\/strong> and <em>useful<\/em> paragraph\.<\/p>/);
    assert.match(html, /<ul>[\s\S]*<li>First<\/li>[\s\S]*<li>Second<\/li>[\s\S]*<\/ul>/);
    assert.match(html, /<table>[\s\S]*<th>Name<\/th>[\s\S]*<td>1<\/td>[\s\S]*<\/table>/);
    assert.match(html, /class="math math-display"/);
    assert.match(html, /<math[^>]+display="block"/);
    assert.match(html, /<msup>/);
    assert.doesNotMatch(html, /<div class="math"><code>/);
});

test('renders MinerU inline LaTeX footnote markers as MathML', () => {
    const html = renderMarkdownHTML(
        'Serge A. Steenen $^{a,b,*}$, Fabienne Linke $^{b}$'
    );

    assert.match(html, /class="math-inline"/);
    assert.match(html, /<math/);
    assert.match(html, /<msup>/);
    assert.doesNotMatch(html, /\$\^\{/);
});

test('renders display LaTeX fractions as block MathML', () => {
    const html = renderMarkdownHTML('$$\n\\frac{x^2}{y_1}\n$$');

    assert.match(html, /class="math math-display"/);
    assert.match(html, /<math[^>]+display="block"/);
    assert.match(html, /<mfrac>/);
    assert.match(html, /<annotation encoding="application\/x-tex">\\frac/);
});

test('splits display LaTeX from following Markdown without a blank line', () => {
    const html = renderMarkdownHTML([
        '$$',
        'x^2',
        '$$',
        'Next **paragraph**',
        '\\[',
        'y_1',
        '\\]',
        'Last paragraph',
    ].join('\n'));

    assert.equal((html.match(/class="math math-display"/g) || []).length, 2);
    assert.match(html, /<\/div>\n<p>Next <strong>paragraph<\/strong><\/p>/);
    assert.match(html, /<msup>/);
    assert.match(html, /<msub>/);
    assert.match(html, /<p>Last paragraph<\/p>/);
});

test('supports bracket delimiters and leaves code spans literal', () => {
    const html = renderMarkdownHTML([
        'Inline \\(x_1 + x_2\\) and code `$x$`.',
        '',
        '\\[',
        '\\sum_{i=1}^{n} i',
        '\\]',
    ].join('\n'));

    assert.match(html, /class="math-inline"/);
    assert.match(html, /<msub>/);
    assert.match(html, /class="math math-display"/);
    assert.match(html, /<munderover>/);
    assert.match(html, /<code>\$x\$<\/code>/);
});

test('preserves escaped currency dollars as literal text', () => {
    assert.equal(renderMarkdownHTML('Cost: \\$5'), '<p>Cost: $5</p>\n');
});

test('renders whitespace-padded and escaped inline TeX', () => {
    const html = renderMarkdownHTML(
        'Padded $ x + y $; percent $x+\\%$; dollar $\\$USD$; paren \\( y \\)'
    );

    assert.equal((html.match(/class="math-inline"/g) || []).length, 4);
    assert.doesNotMatch(html, /class="katex-error"/);
    assert.match(html, /<annotation encoding="application\/x-tex">\\\$USD<\/annotation>/);
});

test('preserves emphasis and links around inline LaTeX', () => {
    const html = renderMarkdownHTML(
        '**bold $x^2$**, *italic \\(y_1\\)*, and [linked $z$](https://example.com)'
    );

    assert.match(html, /<strong>bold <span class="math-inline">/);
    assert.match(html, /<em>italic <span class="math-inline">/);
    assert.match(html, /<a href="https:\/\/example\.com"[^>]*>linked <span class="math-inline">/);
    assert.equal((html.match(/class="math-inline"/g) || []).length, 3);
});

test('does not let Markdown emphasis split LaTeX expressions', () => {
    const html = renderMarkdownHTML([
        '$a*b*c$',
        '$\\text{a *word* here}$',
        '$[x](y)$',
        '\\(d*e*f\\)',
        '**outer $g*h*i$ text**',
    ].join(' '));

    assert.equal((html.match(/class="math-inline"/g) || []).length, 5);
    assert.doesNotMatch(html, /\$a<em>/);
    assert.doesNotMatch(html, /href="y"/);
    assert.match(html, /<strong>outer <span class="math-inline">/);
    assert.match(html, /application\/x-tex">\\text\{a \*word\* here\}<\/annotation>/);
});

test('renders display LaTeX inside tight list items', () => {
    const html = renderMarkdownHTML([
        '- $$ x^2 $$',
        '  First item text',
        '- \\[ y_1 \\]',
        '  Second item text',
    ].join('\n'));

    assert.equal((html.match(/class="math math-display"/g) || []).length, 2);
    assert.match(html, /<li><div class="math math-display">/);
    assert.match(html, /<msup>/);
    assert.match(html, /<msub>/);
    assert.match(html, /First item text/);
    assert.match(html, /Second item text/);
});

test('splits display LaTeX from following text inside a blockquote', () => {
    const html = renderMarkdownHTML([
        '> $$',
        '> z^2',
        '> $$',
        '> Quoted text',
    ].join('\n'));

    assert.match(html, /<blockquote>[\s\S]*class="math math-display"/);
    assert.match(html, /<blockquote>[\s\S]*<p>Quoted text<\/p>/);
});

test('falls back without invoking KaTeX for an oversized formula', () => {
    const source = 'x'.repeat(10_001);
    const html = renderMarkdownHTML(`$${source}$`);

    assert.match(html, /class="math-fallback"/);
    assert.doesNotMatch(html, /<math/);
});

test('keeps invalid LaTeX visible without failing Markdown rendering', () => {
    const html = renderMarkdownHTML('Bad $\\frac{$ formula');

    assert.match(html, /class="katex-error"/);
    assert.match(html, /\\frac\{/);
});

test('does not let currency text consume a later formula delimiter', () => {
    const html = renderMarkdownHTML('Price $5 and formula $x$; then $y$2 and $z$');

    assert.match(html, /Price \$5 and formula/);
    assert.equal((html.match(/class="math-inline"/g) || []).length, 2);
    assert.match(html, /application\/x-tex">x<\/annotation>/);
    assert.match(html, /application\/x-tex">z<\/annotation>/);
});

test('handles many rejected dollar candidates in linear time', () => {
    const markdown = '$1'.repeat(32_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.doesNotMatch(html, /class="math-inline"/);
});

test('handles many unmatched parenthesis delimiters in linear time', () => {
    const markdown = '\\('.repeat(32_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.doesNotMatch(html, /class="math-inline"/);
});

test('handles many unmatched display delimiters in linear time', () => {
    const markdown = '\\[\n'.repeat(16_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.doesNotMatch(html, /class="math math-display"/);
});

test('does not rescan long ordinary Markdown at every inline boundary', () => {
    const markdown = [
        '**word** '.repeat(6_000),
        '[word](https://example.com) '.repeat(2_500),
    ].join('\n\n');
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.match(html, /<strong>word<\/strong>/);
    assert.match(html, /<a href="https:\/\/example\.com"/);
});

test('handles many valid inline formulas in linear time', () => {
    const markdown = '$x$ '.repeat(16_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.match(html, /class="math-inline"/);
});

test('handles formulas split by Markdown tokens in linear time', () => {
    const markdown = '$a*b*c$ '.repeat(8_000);
    const startedAt = performance.now();
    const html = renderMarkdownHTML(markdown);
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 1500, `rendering took ${elapsed.toFixed(0)}ms`);
    assert.match(html, /class="math-inline"/);
    assert.doesNotMatch(html, /\$a<em>/);
});

test('handles large block and inline token arrays without argument overflow', () => {
    const inlineMarkdown = `${'**x** '.repeat(60_000)}$y$`;
    const displayMarkdown = '$$ x $$\ntext\n'.repeat(60_000);

    assert.doesNotThrow(() => renderMarkdownHTML(inlineMarkdown));
    assert.doesNotThrow(() => renderMarkdownHTML(displayMarkdown));
});

test('preserves Markdown after an unmatched parenthesis delimiter', () => {
    const html = renderMarkdownHTML(
        'Text \\( unmatched **bold**, [link](https://example.com), and `code`'
    );

    assert.match(html, /Text \( unmatched/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<a href="https:\/\/example\.com"/);
    assert.match(html, /<code>code<\/code>/);
});

test('does not cross asymmetrically padded formula delimiters', () => {
    const html = renderMarkdownHTML('Variable $ x is unknown and formula $y$');

    assert.match(html, /Variable \$ x is unknown and formula/);
    assert.equal((html.match(/class="math-inline"/g) || []).length, 1);
    assert.match(html, /application\/x-tex">y<\/annotation>/);
});

test('does not expand user-defined TeX macros', () => {
    const html = renderMarkdownHTML('$\\def\\a{xxxxxxxxxx}\\a\\a$');

    assert.match(html, /class="math-fallback"/);
    assert.doesNotMatch(html, /<math/);
});

test('falls back after the document-wide MathML output budget is exhausted', () => {
    const formula = Array.from({ length: 800 }, () => 'x').join('+');
    const markdown = Array.from({ length: 60 }, () => `$${formula}$`).join(' ');
    const html = renderMarkdownHTML(markdown);

    assert.match(html, /<math/);
    assert.match(html, /class="math-fallback"/);
});

test('escapes raw HTML and refuses unsafe links', () => {
    const html = renderMarkdownHTML([
        '<script>alert(1)</script>',
        '',
        '[bad](javascript:alert(1))',
        '',
        '[good](https://example.com)',
    ].join('\n'));

    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('href="javascript:'), false);
    assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
    assert.equal(html.includes('href="https://example.com"'), true);
});

test('preserves escaped Markdown punctuation as literal text', () => {
    assert.equal(
        renderMarkdownHTML('\\# literal \\* text'),
        '<p># literal * text</p>\n'
    );
});

test('renders code blocks whose content contains a shorter fence', () => {
    assert.equal(
        renderMarkdownHTML('````\nbefore\n```\nafter\n````'),
        '<pre><code>before\n```\nafter\n</code></pre>\n'
    );
});

test('preserves query parameters in safe links', () => {
    assert.equal(
        renderMarkdownHTML('[search](https://example.com/?a=1&b=2)'),
        '<p><a href="https://example.com/?a=1&amp;b=2" rel="noreferrer">search</a></p>\n'
    );
});

test('does not create nested links when LaTeX appears in a URL label', () => {
    const bareURL = renderMarkdownHTML('https://example.com/$x$');
    const linkedURL = renderMarkdownHTML(
        '[visit https://example.com/$y$](https://outer.example)'
    );

    assert.equal((bareURL.match(/<a /g) || []).length, 1);
    assert.equal((linkedURL.match(/<a /g) || []).length, 1);
    assert.equal((bareURL.match(/class="math-inline"/g) || []).length, 1);
    assert.equal((linkedURL.match(/class="math-inline"/g) || []).length, 1);
    assert.match(linkedURL, /href="https:\/\/outer\.example"/);
});

test('preserves reference links when formulas split Markdown tokens', () => {
    const html = renderMarkdownHTML([
        '$x$ [Inline reference][paper]',
        '',
        '$$',
        'y^2',
        '$$',
        '[Block reference][paper]',
        '',
        '[paper]: https://example.com/paper',
    ].join('\n'));

    assert.equal((html.match(/href="https:\/\/example\.com\/paper"/g) || []).length, 2);
    assert.equal((html.match(/class="math-inline"/g) || []).length, 1);
    assert.equal((html.match(/class="math math-display"/g) || []).length, 1);
    assert.doesNotMatch(html, /\[Inline reference\]\[paper\]/);
    assert.doesNotMatch(html, /\[Block reference\]\[paper\]/);
});

test('renders language fences and resolved MinerU images', () => {
    const html = renderMarkdownHTML([
        '```js',
        'const answer = 42;',
        '```',
        '',
        '![Figure 1](images/figure.png)',
    ].join('\n'), {
        resolveImageURL: path => path === 'images/figure.png'
            ? 'blob:mktero-figure'
            : null,
    });

    assert.match(html, /<code class="language-js">const answer = 42;/);
    assert.match(html, /<img src="blob:mktero-figure" alt="Figure 1">/);
});

test('does not load unresolved or external Markdown images', () => {
    const html = renderMarkdownHTML('![Remote](https://example.com/tracker.png)');

    assert.equal(html.includes('<img'), false);
    assert.match(html, /class="missing-image">Remote<\/span>/);
});

test('keeps LaTeX in image alt text plain and accessible', () => {
    const missing = renderMarkdownHTML('![$x$](missing.png)');
    const resolved = renderMarkdownHTML('![$x$](figure.png)', {
        resolveImageURL: () => 'blob:mktero-figure',
    });

    assert.match(missing, /class="missing-image">x<\/span>/);
    assert.doesNotMatch(missing, /&lt;span/);
    assert.match(resolved, /alt="x"/);
    assert.doesNotMatch(resolved, /alt="[^"]*&lt;/);
});

test('keeps the safe inline tags emitted by Zotero structured extraction', () => {
    const html = renderMarkdownHTML('H<sub>2</sub>O<br>next');

    assert.equal(html, '<p>H<sub>2</sub>O<br>next</p>\n');
});

test('renders compact raw HTML tables emitted by MinerU', () => {
    const html = renderMarkdownHTML(
        '<table><tr><td>Title {1}</td><td>Value</td></tr></table>'
    );

    assert.equal(
        html,
        '<table><tr><td>Title {1}</td><td>Value</td></tr></table>'
    );
    assert.doesNotMatch(html, /&lt;table&gt;/);
});

test('sanitizes attributes and unsafe elements inside raw HTML tables', () => {
    const html = renderMarkdownHTML([
        '<table onclick="alert(1)"><tr><td colspan="2">Safe',
        '<img src="https://example.com/tracker.png" onerror="alert(2)">',
        '<script>alert(3)</script></td></tr></table>',
    ].join(''));

    assert.match(html, /^<table><tr><td colspan="2">Safe/);
    assert.doesNotMatch(html, /onclick|<script|<img/i);
    assert.match(html, /&lt;img [\s\S]*&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
});

test('preserves safe table spans, formatting, and existing HTML entities', () => {
    const html = renderMarkdownHTML([
        '<table><tr><th rowspan="2" onclick="alert(1)">',
        '<strong>A &amp; B</strong><br>Line 2</th>',
        '<td colspan="2"><em>Value</em></td></tr></table>',
    ].join(''));

    assert.equal(html, [
        '<table><tr><th rowspan="2">',
        '<strong>A &amp; B</strong><br>Line 2</th>',
        '<td colspan="2"><em>Value</em></td></tr></table>',
    ].join(''));
    assert.doesNotMatch(html, /onclick|&amp;amp;/);
});
