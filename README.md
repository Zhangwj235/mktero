# Mktero

**English** · [简体中文](./README.zh-CN.md)

[![Test](https://github.com/tenglvjun/mktero/actions/workflows/test.yml/badge.svg)](https://github.com/tenglvjun/mktero/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/v/release/tenglvjun/mktero)](https://github.com/tenglvjun/mktero/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209-cc2936.svg)](https://www.zotero.org/)

**Read Zotero PDFs as source-linked Markdown.**

Mktero is a restartless Zotero extension for Zotero 7, 8, and 9. It sends a
local PDF to [MinerU](https://mineru.net/) when needed, then opens the
resulting Markdown, formulas, tables, figures, citations, and annotations in a
temporary, reading-first Zotero tab. A content-addressed local cache avoids
repeating conversions for the same PDF.

![Mktero converting, reading, and annotating an academic PDF in Zotero](./docs/assets/mktero-demo.gif)

> [!IMPORTANT]
> Mktero is in beta. On a cache miss, the complete PDF is uploaded to MinerU,
> so a MinerU API Token is required. Optional AI translation sends protected
> Markdown batches to the provider configured by you. Review [Privacy and data
> handling](#privacy-and-data-handling) before processing sensitive documents.

Useful links: [Product page](https://tenglvjun.github.io/mktero/) ·
[Download](https://github.com/tenglvjun/mktero/releases/latest) ·
[Discussions](https://github.com/tenglvjun/mktero/discussions) ·
[Issues](https://github.com/tenglvjun/mktero/issues)

## Features

- Reflow OCR output, multi-column text, formulas, tables, figures, lists, and
  code into a continuous academic reading document.
- Keep reliable page and region mappings so text, formulas, tables, and figures
  can jump back to their PDF source.
- Preview citations, author affiliations, figures, and tables without losing
  the current reading position.
- See whether each Markdown reference already exists in any accessible Zotero
  library. Choose a writable personal or group library, explicitly copy a
  reference from another library, and import missing metadata from the citation
  popup with an optional public PDF attachment.
- Display Zotero PDF highlights and underlines in Markdown, and create,
  recolor, comment on, or delete annotations.
- Correct recognition errors in existing paragraphs, headings, and GFM table
  cells without modifying the immutable MinerU result. Corrections can be
  reviewed, restored, or removed.
- Translate a complete article through a configured Vercel AI SDK provider and
  switch between Original, Translation, and continuous Bilingual reading.
- Explore direct reference relationships among papers already in the current
  Zotero library, using cache-first refreshes from Semantic Scholar,
  OpenCitations, and OpenAlex when identifiers are available.
- Save a portable Zotero snapshot containing HTML, Markdown, source maps, and
  embedded figures.
- Follow Zotero's English or Simplified Chinese display language; other locales
  fall back to English.

## Quick start

### Requirements

- Desktop Zotero `7.0` through `9.0.*`
- A PDF attachment downloaded and available as a local file
- A [MinerU API Token](https://mineru.net/apiManage/token)
- Network access to the MinerU API

MinerU controls file-size, page-count, quota, and service-availability limits.
See the [MinerU API documentation](https://mineru.net/apiManage/docs) for the
current limits.

### Install

1. Download the latest `mktero-<version>.xpi` from
   [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest).
2. In Zotero, open `Tools -> Plugins`.
3. Open the gear menu and choose `Install Add-on From File...`.
4. Select the XPI and follow Zotero's prompts.

Formal GitHub releases receive automatic updates through Zotero. Drafts and
prereleases are not offered as automatic updates.

### Configure

Open `Settings -> Mktero` after installation.

| Setting | Required | Purpose |
| --- | --- | --- |
| MinerU API Token | Yes for a cache miss | Upload and convert PDFs with MinerU |
| AI features and provider settings | Optional | Translate Markdown through a hosted or loopback model service |
| Translation language | Optional | Choose Simplified/Traditional Chinese, Japanese, Korean, Spanish, French, or Brazilian Portuguese |
| Citation provider credentials | Optional | Increase limits for Semantic Scholar, OpenAlex, or OpenCitations; anonymous requests remain supported |
| Body text font and size | Optional | Choose the reading font and a 16–22 px body size |
| Reuse conversion results | Optional | Reuse results for the same PDF content and parser profile |

Credentials are stored as ordinary, unencrypted preferences in the active
Zotero profile. Use `Test connection` to validate an AI endpoint before
translating.

### Open a PDF

1. Open a PDF in Zotero and click the Mktero file icon in the reader toolbar, or
   right-click a PDF or library item and choose `Read as Markdown with Mktero`.
2. Follow the upload, conversion, and download progress in the temporary Mktero
   tab. A valid cache entry skips the remote conversion.
3. Use the outline, citations, figure/table previews, source links, and Zotero
   notes panel to navigate the document.
4. Use the reader toolbar to adjust typography, switch reading mode, translate,
   correct recognition errors, or save a snapshot.

Mktero tabs are session-only and are not restored after Zotero restarts. Closing
the tab or shutting down the extension cancels active conversion and
translation requests.

## Reading and annotation workflows

### Source-aware reading

MinerU content mappings connect Markdown blocks to physical PDF pages and
regions. Source links and source-aware copy use those mappings when they are
reliable; Mktero does not guess a location when a match is ambiguous. Markdown
is rendered in an isolated shadow root with a restricted link and image policy.

### Correct recognition errors

Double-click an existing paragraph, heading, or GFM table cell to edit it, then
save or cancel explicitly. Existing paragraphs and headings can also be
deleted and restored from `Manage corrections`. Corrections are stored
separately from the conversion cache and are tied to the PDF content and MinerU
parser profile. They cannot insert or reorder blocks, add images, or add raw
HTML.

### Annotate from Markdown

Existing Zotero text highlights and underlines are loaded when a document opens.
Selecting Markdown text can create a local annotation immediately; Mktero then
creates the corresponding Zotero annotation only when the local PDF text index
can identify one reliable match. Repeated or ambiguous text remains local and
can be retried instead of receiving a guessed PDF position.

### Translate with AI

AI translation is always opt-in and never rewrites the source Markdown. Mktero
groups the article into bounded Markdown batches, protects formulas, citations,
links, code, images, and structural placeholders, and runs at most five
requests concurrently. Choose `Original`, `Translation`, or `Bilingual` in
the reader. Translations are cached independently by source content, provider,
protocol, model, language, and prompt version, so partial work can resume.

Mktero includes adapters for OpenAI, Anthropic, Google Gemini, DeepSeek,
Alibaba Cloud Model Studio, Moonshot/Kimi, MiniMax, and custom OpenAI-compatible
or Open Responses services through Vercel AI SDK Core. Remote endpoints must
use HTTPS; loopback services such as Ollama or LM Studio may use HTTP.

### Explore the citation graph

The citation graph contains the focused paper and direct references that can be
matched to items already in the current Zotero library. DOI and arXiv
identifiers are queried concurrently from Semantic Scholar, OpenCitations, and
OpenAlex when supported. Matching uses a unique normalized identifier, never a
title, and provider metadata stays local. The graph details include a button
labeled `Open with Mktero`. It opens the first local PDF attachment through the
same Markdown reading workflow as `Read as Markdown with Mktero`.

### Import references from Markdown

Open a citation popup to see local Zotero presence before any network lookup is
made. The popup lists accessible personal and group libraries and lets you
choose the import target. A read-only library remains selectable for presence
checks, while its import actions stay disabled with a permission explanation.
If a matching item exists in another library, Mktero offers an
explicit copy action rather than silently creating a duplicate. Missing
references with a reliable DOI, arXiv ID, or PMID can be imported through
Zotero's native translator. When the target library permits files, Mktero also
tries an arXiv or configured open-access PDF; metadata remains available when
the PDF download fails and can be retried. Select one or more missing references
with the row checkboxes, use `Select all` when needed, and click the toolbar
import icon to import them in one batch. References that import successfully are
cleared from the selection; failed references remain selected so they can be
retried individually or in a later batch.

### Save a portable snapshot

`Save snapshot` creates a dedicated `Mktero Markdown Snapshot` Note under the
PDF's parent item. The Note contains portable HTML; figures are embedded image
attachments; the original Markdown and source map are related attachments.
Mktero refuses to silently overwrite a snapshot Note that you edited. A
standalone PDF without a parent library item cannot save a snapshot.

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

PDFs, MinerU results, archives, image paths, API responses, and preferences are
treated as untrusted input. Archives and Markdown are checked against resource
budgets, archive paths are normalized, remote Markdown images are not loaded,
and raw HTML is escaped or sanitized before rendering.

## Privacy and data handling

| Data | Sent to or stored in | Zotero sync |
| --- | --- | --- |
| Complete PDF on a cache miss | MinerU | Not by Mktero |
| MinerU API Token and AI/provider credentials | Active Zotero profile, unencrypted | No |
| Cached Markdown, figures, source maps, PDF indexes, corrections, and translations | Active Zotero profile, unencrypted | No |
| Focused DOI/arXiv identifiers and provider-specific candidate DOI identifiers | Semantic Scholar, OpenCitations, or OpenAlex | Not by Mktero |
| A normalized DOI, arXiv ID, or PMID after the user clicks `Import reference`; optional open-access PDF request | The selected metadata/PDF provider | Not by Mktero |
| Protected Markdown translation batches | AI provider configured by you | Not by Mktero |
| Zotero PDF annotations | Local Zotero library | According to Zotero settings |
| Saved snapshot Note and attachments | Zotero items and attachments | According to Zotero settings |
| Imported reference metadata and PDF attachments | Active Zotero profile, unencrypted | According to Zotero settings |

Mktero does not send PDF annotations, local PDF.js indexes, Zotero notes,
complete item records, local paths, or cached Markdown to reference/PDF
providers. Reference import requests are local-first and happen only after an
explicit user action; they contain normalized identifiers and configured
provider credentials, never reference text, Zotero keys, or PDF bytes.
Translation requests contain protected Markdown and instructions; if
placeholder validation repeatedly fails, the final retry contains only the
affected block's ordinary text segments. API Tokens, presigned URLs, PDF bytes,
and authenticated responses are not written to logs.

Review the privacy policy of MinerU and any AI or citation provider you enable.
Do not process confidential PDFs unless their data-handling terms are suitable
for your use case.

## Limitations

- Only local PDF attachments are supported. A scanned PDF may convert through
  OCR but still lacks the text layer needed for precise Zotero highlights.
- Source navigation depends on the stable MinerU `*_content_list.json` format;
  older cached results may remain readable without source links.
- Navigation currently goes from Markdown to PDF. Reverse navigation is not
  implemented.
- Mktero displays text highlights and underlines, not standalone notes,
  image/area annotations, or ink annotations.
- Markdown images are limited to supported GIF, JPEG, PNG, and WebP files from
  the current result archive. Remote images are blocked.
- Links are restricted to `http`, `https`, `zotero`, and document fragments.
- Markdown correction mode only edits or removes existing blocks; it cannot
  change document structure, formulas, images, or raw HTML.
- AI translation is an optional cached reading layer. It does not modify source
  Markdown or get included in snapshots.
- Archives, Markdown, images, source maps, PDF indexes, and KaTeX rendering have
  local resource limits and fail safely when those limits are exceeded.

## Troubleshooting

In Zotero, open `Help -> Debug Output Logging`, enable logging, reproduce the
problem, and filter for `Mktero:`. Confirm that the PDF is downloaded locally,
the MinerU Token is valid, and the current network can reach MinerU. Logs do
not contain API Tokens, presigned upload URLs, MinerU batch IDs, or PDF content.

For a confirmed, reproducible bug, open a [GitHub Issue](https://github.com/tenglvjun/mktero/issues)
with the Zotero and Mktero versions, operating system, PDF type, reproduction
steps, expected behavior, and actual behavior. Never attach API Tokens, private
PDFs, authenticated URLs, or local file paths.

## Development

Use the Node.js version in [`.node-version`](./.node-version), currently
`24.15.0`. Node.js 25 is outside the supported dependency range.

```bash
npm ci
npm run check
npm test
npm run build
```

Run one test while iterating with `node --test test/<name>.test.js`. The build
creates the reproducible XPI, SHA-256 checksum, and `build/updates.json` under
`build/`; `build/` and `node_modules/` are generated and ignored.

Keep the versions in `manifest.json`, `package.json`, and `package-lock.json`
consistent before tagging a release. See [AGENTS.md](./AGENTS.md) for the
architecture, security invariants, and contribution checklist.

## Contributing

Pull requests are welcome. For ideas, reading workflows, and beta feedback, use
[GitHub Discussions](https://github.com/tenglvjun/mktero/discussions). For
changes to runtime behavior, run the complete verification commands above and
include tests for the affected behavior. Please keep credentials, private PDFs,
and other sensitive data out of issues, pull requests, and logs.

## License

[MIT](./LICENSE) © 2026 Tony
