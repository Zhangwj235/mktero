# Mktero

**English** · [简体中文](./README.zh-CN.md)

[![Test](https://github.com/tenglvjun/mktero/actions/workflows/test.yml/badge.svg)](https://github.com/tenglvjun/mktero/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/v/release/tenglvjun/mktero)](https://github.com/tenglvjun/mktero/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209-cc2936.svg)](https://www.zotero.org/)

[Product page](https://tenglvjun.github.io/mktero/) · [Download](https://github.com/tenglvjun/mktero/releases/latest) · [Discussions](https://github.com/tenglvjun/mktero/discussions)

Mktero is a source-linked reflow reader for Zotero 7, 8, and 9. It converts a
local PDF with MinerU, then opens the resulting Markdown, formulas, tables,
figures, citations, and annotations in a reading-first Zotero tab. An optional
correction mode lets you fix recognition errors without changing the immutable
MinerU result, while optional AI translation can translate the full article in
bounded concurrent Markdown batches and switch between original, translated, and
continuous block-level bilingual reading.

![Mktero converting, reading, and annotating an academic PDF in Zotero](./docs/assets/mktero-demo.gif)

Read complex papers as a continuous document, annotate them from either view,
and return to the original PDF whenever you need to verify the evidence.

> [!IMPORTANT]
> Mktero is currently in beta. On a cache miss, it uploads the complete PDF to
> MinerU for conversion. A MinerU API Token is required. See
> [Privacy and data handling](#privacy-and-data-handling) before using Mktero
> with sensitive documents. AI translation separately sends protected Markdown
> batches to the provider you configure, with up to five requests active at
> once.

## Quick start

### Requirements

- Desktop Zotero `7.0` through `9.0.*`
- A PDF attachment available as a local file
- A [MinerU API Token](https://mineru.net/apiManage/token)
- Network access to the MinerU API

File-size, page-count, quota, and service-availability limits are controlled by
MinerU. Refer to the [MinerU API documentation](https://mineru.net/apiManage/docs)
for current limits.

### Install

1. Download `mktero-0.2.8.xpi` from
   [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest).
2. In Zotero, open `Tools -> Plugins`.
3. Open the gear menu and choose `Install Add-on From File...`.
4. Select the XPI and follow Zotero's prompts.

Formal GitHub releases receive automatic updates through Zotero. Drafts and
prereleases are not offered as automatic updates.

### Configure

Open `Settings -> Mktero` after installation.

| Setting | Default | Purpose |
| --- | --- | --- |
| API Token | Empty | Required when a conversion is not available locally |
| Body text font | System serif | Choose System serif, Georgia, Cambria, or Times New Roman |
| Body text size | 18 px | Adjust Markdown and snapshot text from 16 to 22 px while keeping a wide, stable reading column |
| Reuse conversion results | On | Reuse results for the same PDF content and parser profile |
| Enable AI features | Off | Allow Markdown translation through the configured model service |
| Stream responses | On | Stream each Markdown batch response; turn off to wait for each batch to finish |
| AI base URL / API Key / provider / protocol / model | OpenAI Responses / empty model | Route AI calls through Vercel AI SDK Core to a hosted provider or loopback model server |
| Translation language | Simplified Chinese | Choose Simplified/Traditional Chinese, English, Japanese, Korean, Spanish, French, or Brazilian Portuguese for new translations |
| Request timeout | 600,000 ms | Allow up to one hour for each batch request |
| Maximum output tokens | Automatic (0) | Let the provider choose by default, or allow up to 262,144 tokens when the selected model supports it |

The Mktero settings pane uses an aligned two-column layout for labels and
controls, keeps Zotero's native select affordance, and uses explicit
contrasting controls so configured values remain legible in Zotero's light and
dark themes.

The MinerU API Token and AI API Key are stored unencrypted as normal
preferences in the active Zotero profile. Use `Test connection` to validate
the current AI endpoint, key, and model before translating. This probe only
requires a successful provider response; a reasoning-only response without
visible text is sufficient.

### Open and read a PDF

1. Open a PDF and select the Mktero file icon in the reader toolbar, or
   right-click one PDF or one library item and choose
   `Read as Markdown with Mktero`.
2. Mktero opens a temporary tab and reports upload, conversion, and download
   progress. A valid cache entry skips the remote conversion.
3. Use the outline, citation and figure previews, source links, and Zotero notes
   panel to navigate the document.
4. Use the fixed toolbar above the Markdown body to change text size and font,
   select a reading mode, or translate the article. These controls use compact,
   even spacing, with in-flight progress condensed onto the main toolbar row at
   normal reader widths and the translation action separated from reading mode.
   The More menu contains `Manage corrections`, `Retranslate document`,
   `Reparse PDF`, and `Save snapshot` when those actions are available.

Reparsing uploads the PDF again and may consume MinerU quota. The current
Markdown remains readable until a replacement is ready. Mktero tabs are
session-only and are not restored after Zotero restarts.

### Correct recognition errors

Double-click a paragraph, heading, or GFM table cell directly from the normal
reading view. Press `Enter` or `F2` after focusing an editable block as a
keyboard alternative. Text and table changes use the same explicit action bar:
the Save button is enabled only after a change, while Save, Cancel, and
`Ctrl/Command+Enter` or `Escape` provide matching commit and cancel behavior.
Leaving a table cell does not save it automatically. If saving fails, the
current input stays in place so you can retry or cancel. The same action bar
can delete a whole paragraph or heading without removing it one character at a
time; a short Undo deletion prompt is shown after a successful deletion.

Choose `Manage corrections` from the More menu to review corrected blocks and
restore an individual deletion. Deleted blocks appear as compact, reversible
placeholders only in this management mode. Normal reading hides correction
markers and collapses the gaps left by deleted blocks, while the More menu can
restore all corrections.

Corrections are tied to the current PDF content and MinerU parser profile. They
are stored separately from the conversion cache, so clearing or expiring the
cache does not remove them. `Reparse PDF` asks before permanently deleting
corrections; this MVP does not merge corrections into a newly parsed result.
Editing is intentionally limited to existing paragraphs, headings, and GFM
table cells: existing paragraphs and headings can be removed, but blocks cannot
be inserted or reordered, and corrections cannot add images or raw HTML.

If Actions & Tags for Zotero is installed, Mktero integrates with compatible
`openFile` and `closeTab` rules for sessions it owns without duplicating native
reader actions.

### Translate a Markdown article with AI

Configure and enable AI translation in `Settings -> Mktero`, then select
`Translate document` in a Markdown tab's toolbar. Mktero groups the protected
Markdown document at top-level H1 headings, divides each group into batches of
up to eight blocks and about 2,000 estimated source tokens, and keeps up to five
batch requests active. Responses are matched by block ID and merged in source
order. Missing or invalid blocks are retried individually up to two times.
Blocks that still fail keep their source text and leave the translation in a
retryable partial state. Reference sections are kept unchanged. Code, images, standalone formulas,
link definitions, raw HTML, URLs,
and inline code are replaced with protected placeholders before each request
and restored only after the response passes structural validation. Translation
is always an explicit action and never rewrites the source Markdown or becomes
part of a saved snapshot. Streaming is enabled by default for provider
transport. While translation is running, the toolbar
action shows a loading spinner, target language, translated block count, and
percentage; it remains available as `Cancel translation`, so select it again to
stop the request. Existing original, translated, and bilingual views remain
available while a retry runs in the background. The reader switches to the
translated document after all requested batches settle. An incomplete result remains
visible, marks every source-text fallback, and supports retrying all incomplete
translation from the toolbar or jumping between failures. The failure navigator
shows the current position and total, for example `1/3`.
Connection tests always use a short non-streaming request.

After translation, use the reading-mode selector to choose `Original`,
`Translation`, or `Bilingual`. Original is the default whenever a document
opens. Bilingual presents one continuous reading document: every source
heading, paragraph, list, blockquote, or table is immediately followed by its
translation. Translated blocks use a restrained left rule, indentation, and
lower heading emphasis, while the outline contains only source headings. The
toolbar always shows the translation language, adds progress while work is in
flight, and shows only the untranslated count for a partial result. A complete
result omits the redundant `N/N` count. The single reading surface remains
usable when Zotero's side panels reduce the available document width. In
Bilingual mode, PDF annotations, source navigation, sourced copy, and new
Markdown annotations remain available on source blocks; translated blocks do
not expose source-only actions. Bilingual blocks remain visually stable while
reading and do not expose per-block translation actions. `Retranslate document`
in the More menu regenerates the complete translation with the current settings.

All AI calls pass through Vercel AI SDK Core. Mktero includes adapters for
OpenAI, Anthropic, Google Gemini, DeepSeek, Alibaba Cloud Model Studio,
Moonshot/Kimi, and MiniMax, plus a custom service option. The selected protocol
determines whether the adapter uses OpenAI Responses, OpenAI Chat Completions,
Open Responses, Anthropic Messages, or Google Generative Language. Only valid
provider/protocol combinations are selectable. Model availability and IDs
remain provider-specific. Remote endpoints must use HTTPS. Loopback servers
such as Ollama or LM Studio may use HTTP and may omit the API Key when
authentication is disabled.

The translated blocks are stored inside the corresponding PDF Markdown cache
entry and keyed by source content, provider, protocol, model, target language,
and prompt version. The translated and bilingual reading
documents are rebuilt from those blocks in source order, so existing cached
translations can adopt presentation updates without another AI request.
Clearing, replacing, or evicting that Markdown cache entry removes its
translation. Lists, blockquotes, and GFM tables are translated; images, code,
standalone formulas, link definitions, and raw HTML are preserved. Closing the
tab, reparsing, editing the Markdown, or shutting down Mktero cancels active
translation requests.

### Save a portable Zotero snapshot

Choose `Save snapshot` to create a dedicated `Mktero Markdown Snapshot` Note
under the PDF's parent item. Mktero stores portable HTML in the Note, figures as
embedded image attachments, and the original Markdown and source map as related
attachments. Zotero can then sync those items normally.

Desktop clients with Mktero prefer the synchronized Markdown source. Other
clients can read the portable HTML Note. Mktero refuses to silently overwrite a
snapshot Note that the user has edited. A standalone PDF without a parent
library item cannot save a snapshot.

## Highlights

- Reflows OCR output, multi-column text, formulas, tables, figures, lists, and
  code into a continuous reading document.
- Corrects recognition errors in existing paragraphs, headings, and GFM table
  cells, including removing spurious paragraphs or headings, while preserving
  the original MinerU Markdown and correction history.
- Translates full Markdown articles through a configured Vercel AI SDK provider
  and offers original, translated, and continuous block-level bilingual reading.
- Uses paper-oriented typography with STIX/Noto serif fallbacks, and applies
  asynchronous Shiki syntax highlighting, language labels, and code copying to
  supported fenced code blocks.
- Restores adjacent academic table and figure captions when MinerU places a
  caption before or after a table, assigns a table caption to the next image,
  or extracts a composite figure's panel label separately from its caption.
- Preserves reliable page and region mappings so text, formulas, tables, and
  figures can return to their PDF source.
- Previews citations, author affiliations, figures, and tables without leaving
  the reading position.
- Displays Zotero PDF highlights and underlines in Markdown and lets you create,
  recolor, comment on, and delete annotations.
- Copies selected content with the paper title, physical PDF pages, and Zotero
  backlinks when reliable source information is available.
- Keeps a content-addressed local cache and resumes recently uploaded MinerU
  tasks without uploading the same PDF again.
- Follows Zotero's display language for English and Simplified Chinese; other
  locales fall back to English.

## How it works

```text
Local Zotero PDF
        |
        v
MinerU conversion -----> Markdown + figures + content map
        |                               |
        v                               v
Local content cache             Safe normalization/rendering
                                        |
                                        v
                           Reading-first Mktero tab in Zotero
```

Mktero treats PDFs, conversion results, archives, image paths, API responses,
and preferences as untrusted input. Markdown is normalized and rendered inside
an isolated shadow root; it is not inserted as arbitrary HTML into Zotero's
chrome document.

## Annotations and source links

Existing Zotero text highlights and underlines are loaded fresh whenever a
document opens. Selecting ordinary Markdown text can create a local highlight
or note immediately. Mktero then uses a local PDF.js text index to create the
matching Zotero annotation only when the text can be located reliably. Failed
or ambiguous matches stay visible locally and can be retried; Mktero does not
guess a PDF position. Matching tolerates common extraction differences in
citation superscripts, statistical exponents, and words split across PDF
lines.

Reliable MinerU content mappings also enable source navigation and
source-aware copying. Page hints narrow annotation matching to the correct
physical PDF page, while mapped region coordinates are used only for source
navigation, not as guessed annotation rectangles.

## Privacy and data handling

| Data | Where it goes | Zotero sync |
| --- | --- | --- |
| Complete PDF on a cache miss | Uploaded to MinerU | Not by Mktero |
| API Token | Active Zotero profile, unencrypted | No |
| AI API Key | Active Zotero profile, unencrypted | No |
| Protected translatable Markdown batches selected for full translation | Configured AI provider | Not by Mktero |
| Cached Markdown, figures, source maps, and PDF text indexes | Active Zotero profile, unencrypted | No |
| Cached AI translations | Active Zotero profile, unencrypted | No |
| Pending MinerU task IDs and timestamps | Active Zotero profile, unencrypted | No |
| Pending Markdown annotation records | Active Zotero profile, unencrypted until synchronized | No |
| Corrected Markdown blocks and their base figures/source maps | Active Zotero profile, unencrypted | No |
| Synchronized PDF annotations | Local Zotero library | According to Zotero settings |
| Saved snapshot Note, HTML, Markdown, source map, and figures | Zotero items and attachments, unencrypted | According to Zotero settings |

The local cache does not contain API Tokens, AI API Keys, or PDF annotation
comments. PDF annotations and local PDF.js indexes are not sent to MinerU or
the AI provider. Translation sends protected Markdown batches and translation
instructions to the configured AI provider, with at most five requests active at
once. Source-aware copy reads
local item metadata and writes only the generated result to the system clipboard.

Correction data is kept outside the normal conversion cache under the active
Zotero profile. Clearing the cache does not clear corrections. Corrections are
local to this device unless they are included in a saved Zotero snapshot; a
corrected snapshot carries an explicit provenance notice and correction count.

Pending-task records contain only MinerU task identifiers, Mktero data IDs, and
upload timestamps. They do not contain the PDF, its filename or path, upload or
download URLs, the API Token, or authenticated API responses.

Saved snapshots do not include the original PDF, the MinerU result archive, the
API Token, or API responses. Their synchronization and storage quota are
controlled by Zotero.

## Security boundaries and current limitations

- Markdown is read-only by default. Correction mode can replace the content of
  existing paragraphs, headings, and GFM table cells, or remove an existing
  paragraph or heading. It cannot otherwise change document structure, formulas,
  images, or raw HTML. Annotation actions remain separate from Markdown
  corrections.
- AI translation is an optional cached reading layer. It never starts
  automatically, modifies source Markdown, syncs through Zotero, or saves
  translations into snapshots. Mktero requests non-reasoning generation to keep
  translation responsive. If the selected model or Provider explicitly rejects
  disabling reasoning, Mktero retries once with that Provider's default behavior.
  Mktero does not expose a reasoning-effort setting.
- Only local PDF attachments are supported. Missing or undownloaded files
  cannot be converted.
- Text annotations require extractable PDF text. A scanned PDF may convert via
  OCR but still cannot produce precise Zotero highlight rectangles.
- Mktero currently displays text highlights and underlines, not standalone
  notes, image/area annotations, or ink annotations.
- Source navigation requires the stable MinerU `*_content_list.json` format.
  Older cache entries remain readable but may not have source links.
- Navigation currently goes from Markdown to PDF. Reverse navigation is not
  implemented.
- Markdown images resolve only supported GIF, JPEG, PNG, and WebP files from the
  current result archive; remote Markdown images are not loaded.
- Links are restricted to `http`, `https`, `zotero`, and document fragments.
- Raw HTML is escaped by default. Sanitized MinerU tables allow only a limited
  set of tags and attributes.
- Archives, Markdown, images, source maps, PDF indexes, and KaTeX rendering all
  have local resource budgets and fail safely when limits are exceeded.

## Troubleshooting

In Zotero, open `Help -> Debug Output Logging`, enable logging, reproduce the
conversion, and filter the output for `Mktero:`. Useful stages include:

- `requesting a MinerU upload URL`
- `uploading PDF to MinerU`
- `PDF upload completed; MinerU is parsing`
- `MinerU parsing finished; downloading the result`
- `completed from local cache; MinerU upload skipped`
- `completed from a resumed MinerU task`

Logs do not contain API Tokens, presigned upload URLs, MinerU batch IDs, or PDF
content. If conversion still fails, confirm that the attachment is available
locally, the Token is valid, and MinerU is reachable from the current network.

## Development

Use Node.js `24.15.0` from [`.node-version`](./.node-version). Node.js 25 is
outside the supported dependency engine range.

```bash
npm ci
npm run check
npm test
npm run build
```

The build creates the unpacked extension, a reproducible
`build/mktero-0.2.8.xpi`, its SHA-256 checksum, and `build/updates.json`.
Generated `build/` and `node_modules/` directories are ignored and must not be
committed.

Before creating the release tag, keep the versions in `manifest.json`,
`package.json`, and `package-lock.json` consistent. Create and push the annotated
tag with:

```bash
git tag v0.2.8 -m "Mktero 0.2.8"
git push origin v0.2.8
```

The release workflow checks the tag against `manifest.json` before publishing.
Pushes and pull requests run the test, build, and CodeQL workflows without
publishing a release.

See [AGENTS.md](./AGENTS.md) for the repository architecture, coding rules,
security invariants, and cross-file change checklist.

## Feedback and contributing

- Use [GitHub Discussions](https://github.com/tenglvjun/mktero/discussions) for
  reading workflows, ideas, and beta feedback.
- Use [GitHub Issues](https://github.com/tenglvjun/mktero/issues) for confirmed,
  reproducible bugs.

Include the Zotero and Mktero versions, operating system, PDF type,
reproduction steps, expected behavior, and actual behavior. Never attach API
Tokens, private PDFs, authenticated URLs, local file paths, or other sensitive
information.

Pull requests are welcome. Run the complete verification commands above and
follow [AGENTS.md](./AGENTS.md) when changing runtime behavior.

## License

[MIT](./LICENSE) © 2026 Tony
