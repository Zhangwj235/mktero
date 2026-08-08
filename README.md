# Mktero

**English** · [简体中文](./README.zh-CN.md)

[![Test](https://github.com/tenglvjun/mktero/actions/workflows/test.yml/badge.svg)](https://github.com/tenglvjun/mktero/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/v/release/tenglvjun/mktero)](https://github.com/tenglvjun/mktero/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209-cc2936.svg)](https://www.zotero.org/)

[Product page](https://tenglvjun.github.io/mktero/) · [Download](https://github.com/tenglvjun/mktero/releases/latest) · [Discussions](https://github.com/tenglvjun/mktero/discussions)

Mktero is a source-linked reflow reader for Zotero 7, 8, and 9. It converts a
local PDF with MinerU, then opens the resulting Markdown, formulas, tables,
figures, citations, and annotations in a read-only Zotero tab.

![Mktero converting, reading, and annotating an academic PDF in Zotero](./docs/assets/mktero-demo.gif)

Read complex papers as a continuous document, annotate them from either view,
and return to the original PDF whenever you need to verify the evidence.

> [!IMPORTANT]
> Mktero is currently in beta. On a cache miss, it uploads the complete PDF to
> MinerU for conversion. A MinerU API Token is required. See
> [Privacy and data handling](#privacy-and-data-handling) before using Mktero
> with sensitive documents.

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

1. Download `mktero-<version>.xpi` from
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
| Body text size | 18 px | Adjust Markdown and snapshot text from 16 to 22 px |
| Reuse conversion results | On | Reuse results for the same PDF content and parser profile |

The API Token is stored unencrypted as a normal preference in the active
Zotero profile.

### Open and read a PDF

1. Open a PDF and select the Mktero file icon in the reader toolbar, or
   right-click one PDF or one library item and choose
   `Read as Markdown with Mktero`.
2. Mktero opens a temporary tab and reports upload, conversion, and download
   progress. A valid cache entry skips the remote conversion.
3. Use the outline, citation and figure previews, source links, and Zotero notes
   panel to navigate the document.
4. Use the fixed toolbar above the Markdown body to change font and text size.
   The More menu contains `Reparse PDF` and `Save snapshot`.

Reparsing uploads the PDF again and may consume MinerU quota. The current
Markdown remains readable until a replacement is ready. Mktero tabs are
session-only and are not restored after Zotero restarts.

If Actions & Tags for Zotero is installed, Mktero integrates with compatible
`openFile` and `closeTab` rules for sessions it owns without duplicating native
reader actions.

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
  code into a continuous read-only document.
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
                           Read-only Mktero tab in Zotero
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
guess a PDF position.

Reliable MinerU content mappings also enable source navigation and
source-aware copying. Page hints narrow annotation matching to the correct
physical PDF page, while mapped region coordinates are used only for source
navigation, not as guessed annotation rectangles.

## Privacy and data handling

| Data | Where it goes | Zotero sync |
| --- | --- | --- |
| Complete PDF on a cache miss | Uploaded to MinerU | Not by Mktero |
| API Token | Active Zotero profile, unencrypted | No |
| Cached Markdown, figures, source maps, and PDF text indexes | Active Zotero profile, unencrypted | No |
| Pending MinerU task IDs and timestamps | Active Zotero profile, unencrypted | No |
| Pending Markdown annotation records | Active Zotero profile, unencrypted until synchronized | No |
| Synchronized PDF annotations | Local Zotero library | According to Zotero settings |
| Saved snapshot Note, HTML, Markdown, source map, and figures | Zotero items and attachments, unencrypted | According to Zotero settings |

The local cache does not contain API Tokens or PDF annotation comments. PDF
annotations and local PDF.js indexes are not sent to MinerU. Source-aware copy
reads local item metadata and writes only the generated result to the system
clipboard.

Pending-task records contain only MinerU task identifiers, Mktero data IDs, and
upload timestamps. They do not contain the PDF, its filename or path, upload or
download URLs, the API Token, or authenticated API responses.

Saved snapshots do not include the original PDF, the MinerU result archive, the
API Token, or API responses. Their synchronization and storage quota are
controlled by Zotero.

## Security boundaries and current limitations

- Markdown document content is read-only. Annotation actions create local
  records and synchronize reliable matches to Zotero PDF annotations; they do
  not edit the converted Markdown.
- Only local PDF attachments are supported. Missing or undownloaded files
  cannot be converted.
- Text annotations require extractable PDF text. A scanned PDF may convert via
  OCR but still cannot produce precise Zotero highlight rectangles.
- Mktero currently displays text highlights and underlines, not standalone
  notes, image/area annotations, or ink annotations.
- Source navigation requires the stable MinerU `*_content_list.json` format.
  Older cache entries remain readable but may not have source links.
- Navigation currently goes from Markdown to PDF. Reverse navigation,
  side-by-side reading, and synchronized scrolling are not implemented.
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
`build/mktero-<version>.xpi`, its SHA-256 checksum, and `build/updates.json`.
Generated `build/` and `node_modules/` directories are ignored and must not be
committed.

Before creating a `v<version>` tag, keep the versions in `manifest.json`,
`package.json`, and `package-lock.json` consistent. The release workflow checks
the tag against `manifest.json` before publishing. Pushes and pull requests run
the test, build, and CodeQL workflows without publishing a release.

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
