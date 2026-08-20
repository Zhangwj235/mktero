# Mktero

[English](./README.md) · **简体中文**

[![测试](https://github.com/tenglvjun/mktero/actions/workflows/test.yml/badge.svg)](https://github.com/tenglvjun/mktero/actions/workflows/test.yml)
[![最新版本](https://img.shields.io/github/v/release/tenglvjun/mktero)](https://github.com/tenglvjun/mktero/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209-cc2936.svg)](https://www.zotero.org/)

**在 Zotero 中以带来源链接的 Markdown 阅读 PDF。**

Mktero 是适用于 Zotero 7、8 和 9 的无需重启扩展。需要时，它会将本地 PDF
发送到 [MinerU](https://mineru.net/) 进行转换，再在临时的阅读优先 Zotero 标签页中
打开 Markdown、公式、表格、图片、引用和标注。内容寻址的本地缓存会复用同一 PDF 的转换结果，避免重复处理。

![Mktero 在 Zotero 中转换、阅读和标注学术 PDF](./docs/assets/mktero-demo.gif)

> [!IMPORTANT]
> Mktero 目前处于 Beta 阶段。缓存未命中时，完整 PDF 会上传到 MinerU，因此需要
> MinerU API Token。可选的 AI 翻译会把受保护的 Markdown 批次发送给你配置的 Provider。
> 处理敏感文档前，请阅读[数据与隐私](#数据与隐私)。

常用链接：[产品介绍页](https://tenglvjun.github.io/mktero/) ·
[下载最新版本](https://github.com/tenglvjun/mktero/releases/latest) ·
[Discussions](https://github.com/tenglvjun/mktero/discussions) ·
[Issues](https://github.com/tenglvjun/mktero/issues)

## 核心能力

- 将 OCR 结果、双栏正文、公式、表格、图片、列表和代码重排成连续的论文阅读文档。
- 保留可靠的页码和区域映射，使正文、公式、表格和图片可以跳回 PDF 来源。
- 在不丢失当前位置的情况下预览引用、作者单位、图片和表格。
- 在 Markdown 中显示 Zotero PDF 高亮和下划线，并支持新建、编辑、改色、评论和删除标注。
- 在不修改不可变 MinerU 结果的前提下，校对已有段落、标题和 GFM 表格单元格；校对内容可查看、恢复或删除。
- 通过配置的 Vercel AI SDK Provider 翻译整篇文章，并在原文、译文和连续块级双语阅读之间切换。
- 只在当前 Zotero 文库内展示可匹配的直接引用关系，并在支持时使用 Semantic Scholar、OpenCitations 和 OpenAlex 刷新数据。
- 保存包含 HTML、Markdown、来源映射和内嵌图片的便携 Zotero 快照。
- 界面跟随 Zotero 的英文或简体中文显示语言，其他语言回退为英文。

## 快速开始

### 使用要求

- 桌面版 Zotero `7.0` 至 `9.0.*`
- 已下载并可在本机访问的 PDF 附件
- [MinerU API Token](https://mineru.net/apiManage/token)
- 能够访问 MinerU API 的网络环境

文件大小、页数、账户额度和服务可用性由 MinerU 控制，请以
[MinerU API 文档](https://mineru.net/apiManage/docs)中的当前限制为准。

### 安装

1. 从 [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest)
   下载最新的 `mktero-<version>.xpi`。
2. 在 Zotero 中打开 `工具 -> 插件`。
3. 打开齿轮菜单，选择 `Install Add-on From File...`。
4. 选择 XPI 文件并按 Zotero 提示完成安装。

正式 GitHub Release 可以通过 Zotero 自动更新；草稿和预发布版本不会成为自动更新目标。

### 配置

安装后打开 `设置 -> Mktero`。

| 设置 | 是否必需 | 作用 |
| --- | --- | --- |
| MinerU API Token | 缓存未命中时必需 | 使用 MinerU 上传并转换 PDF |
| AI 功能和 Provider 设置 | 可选 | 通过托管或本地回环模型服务翻译 Markdown |
| 翻译语言 | 可选 | 简体/繁体中文、日文、韩文、西班牙语、法语或巴西葡萄牙语 |
| 引用 Provider 凭据 | 可选 | 提高 Semantic Scholar、OpenAlex 或 OpenCitations 的请求额度；也支持匿名请求 |
| 正文字体和字号 | 可选 | 选择阅读字体，并在 16–22 px 间调整字号 |
| 复用转换结果 | 可选 | 复用相同 PDF 内容和解析配置对应的结果 |

凭据会作为普通的未加密首选项存储在当前 Zotero 配置文件中。开始翻译前，可以使用
`测试连接`验证 AI 地址。

### 打开 PDF

1. 在 Zotero 中打开 PDF，点击阅读器工具栏的 Mktero 文件图标；也可以右键 PDF 或文库条目，选择
   `Read as Markdown with Mktero`。
2. 在临时 Mktero 标签页中查看上传、转换和下载进度。存在有效缓存时会跳过远程转换。
3. 使用目录、引用、图表预览、来源链接和 Zotero 笔记面板浏览文档。
4. 使用阅读器工具栏调整字体、切换阅读模式、翻译、校对识别错误或保存快照。

Mktero 标签页是会话级的，Zotero 重启后不会恢复。关闭标签页或关闭扩展时，进行中的转换和翻译请求会被取消。

## 阅读与标注工作流

### 带来源的阅读

MinerU 内容映射会把 Markdown 内容块连接到 PDF 的物理页码和区域。来源跳转和附带来源复制只在映射可靠时执行；匹配存在歧义时不会猜测位置。Markdown 在隔离的 shadow root 中渲染，并使用受限的链接和图片策略。

### 校对识别错误

双击已有段落、标题或 GFM 表格单元格即可编辑，然后显式保存或取消。在 `Manage corrections` 中还可以删除和恢复已有段落或标题。校对数据独立于转换缓存，并绑定当前 PDF 内容和 MinerU 解析配置；不能插入或重排内容块，也不能添加图片或原始 HTML。

### 从 Markdown 创建标注

打开文档时会加载已有的 Zotero 文本高亮和下划线。选中 Markdown 文本后可以立即创建本地标注；只有本地 PDF 文字索引能够可靠定位唯一位置时，Mktero 才会创建对应的 Zotero 标注。重复或歧义文本会保留在本地并可重试，不会被放置到猜测的位置。

### 使用 AI 翻译

AI 翻译始终需要用户主动触发，也不会重写原始 Markdown。Mktero 会把文章拆成受控的 Markdown 批次，保护公式、引用、链接、代码、图片和结构占位符，并最多同时执行 5 个请求。阅读器支持 `Original`、`Translation` 和 `Bilingual` 三种模式；部分结果会按内容块继续补译。

译文会按照源内容、Provider、协议、模型、语言和提示词版本独立缓存。Mktero 通过 Vercel AI SDK Core 支持 OpenAI、Anthropic、Google Gemini、DeepSeek、阿里云百炼、Moonshot/Kimi、MiniMax，以及自定义 OpenAI 兼容或 Open Responses 服务。远程地址必须使用 HTTPS；Ollama、LM Studio 等本地回环服务可以使用 HTTP。

### 浏览引用图谱

引用图谱只包含当前论文，以及能匹配到当前 Zotero 文库条目的直接引用。支持时会并发查询 Semantic Scholar、OpenCitations 和 OpenAlex。匹配只使用唯一且规范化的 DOI 或 arXiv 标识符，不使用标题；Provider 返回的元数据保存在本地。

### 保存便携快照

`Save snapshot` 会在 PDF 所属条目下创建专用的 `Mktero Markdown Snapshot` Note。Note 保存便携 HTML，图片作为内嵌附件，原始 Markdown 和来源映射作为关联附件。用户修改过快照 Note 后，Mktero 不会静默覆盖。没有父级文库条目的独立 PDF 无法保存快照。

## 工作原理

```text
Zotero 本地 PDF
        |
        v
MinerU 转换 ----------> Markdown + 图片 + 内容映射
        |                              |
        v                              v
本地内容缓存                    安全规范化与渲染
                                       |
                                       v
                            Zotero 中的 Mktero 阅读标签页
```

PDF、MinerU 结果、压缩包、图片路径、API 响应和首选项都会被视为不可信输入。压缩包和 Markdown 会检查资源预算，归档路径会被规范化，远程 Markdown 图片不会加载，原始 HTML 会在渲染前转义或清理。

## 数据与隐私

| 数据 | 发送到或存储在 | Zotero 同步 |
| --- | --- | --- |
| 缓存未命中时的完整 PDF | MinerU | Mktero 不同步 |
| MinerU API Token 和 AI/Provider 凭据 | 当前 Zotero 配置文件，未加密 | 否 |
| 缓存的 Markdown、图片、来源映射、PDF 索引、校对和译文 | 当前 Zotero 配置文件，未加密 | 否 |
| 当前论文的 DOI/arXiv 标识符及 Provider 所需的候选 DOI | Semantic Scholar、OpenCitations 或 OpenAlex | Mktero 不同步 |
| 受保护的 Markdown 翻译批次 | 你配置的 AI Provider | Mktero 不同步 |
| Zotero PDF 标注 | 本地 Zotero 文库 | 取决于 Zotero 设置 |
| 保存的快照 Note 和附件 | Zotero 条目和附件 | 取决于 Zotero 设置 |

Mktero 不会把 PDF 标注、本地 PDF.js 索引、Zotero 笔记、完整条目记录、本地路径或缓存 Markdown 发送给 MinerU 或引用 Provider。翻译请求包含受保护的 Markdown 和指令；如果占位符校验连续失败，最后一次重试只发送受影响内容块中的普通文本片段。日志不会写入 API Token、预签名地址、PDF 字节或带认证的响应。

请同时阅读 MinerU、AI Provider 和引用 Provider 的隐私政策。除非相关数据处理条款符合你的使用场景，否则不要处理机密 PDF。

## 当前限制

- 仅支持本地 PDF 附件。扫描版 PDF 可以通过 OCR 转换，但没有文字层时无法生成精确的 Zotero 高亮。
- 来源跳转依赖稳定的 MinerU `*_content_list.json`；旧缓存可能仍可阅读，但没有来源链接。
- 当前只支持从 Markdown 跳转到 PDF，不支持反向跳转。
- 目前显示文本高亮和下划线，不显示独立便签、图片/区域标注或手写标注。
- Markdown 图片仅限当前结果压缩包中的 GIF、JPEG、PNG 和 WebP；远程图片会被阻止。
- 链接协议仅允许 `http`、`https`、`zotero` 和文档片段。
- 校对模式只能编辑或删除已有内容块，不能改变文档结构、公式、图片或原始 HTML。
- AI 翻译是可选的缓存阅读层，不修改源 Markdown，也不会写入快照。
- 压缩包、Markdown、图片、来源映射、PDF 索引和 KaTeX 渲染都有本地资源上限，超限时会安全停止处理。

## 转换排障

在 Zotero 中打开 `帮助 -> 调试输出日志`，启用日志后重现问题，并筛选 `Mktero:`。请确认 PDF 已下载到本机、MinerU Token 有效且当前网络可以访问 MinerU。日志不会包含 API Token、预签名上传地址、MinerU batch ID 或 PDF 内容。

确认问题可复现后，请提交 [GitHub Issue](https://github.com/tenglvjun/mktero/issues)，并附上 Zotero 与 Mktero 版本、操作系统、PDF 类型、复现步骤、预期行为和实际行为。请勿附带 API Token、私密 PDF、带认证链接或本地文件路径。

## 开发

使用 [`.node-version`](./.node-version) 指定的 Node.js 版本，目前为 `24.15.0`。Node.js 25 不在支持范围内。

```bash
npm ci
npm run check
npm test
npm run build
```

迭代时可以使用 `node --test test/<name>.test.js` 运行单个测试。构建会在 `build/` 下生成可复现的 XPI、SHA-256 校验文件和 `build/updates.json`；`build/` 与 `node_modules/` 都是生成目录并已被忽略。

发布前请保持 `manifest.json`、`package.json` 和 `package-lock.json` 的版本一致。仓库架构、安全约束和贡献检查清单见 [AGENTS.md](./AGENTS.md)。

## 贡献

欢迎提交 Pull Request。功能想法、阅读工作流和 Beta 反馈请前往
[GitHub Discussions](https://github.com/tenglvjun/mktero/discussions)；确认且可复现的问题请提交到 [GitHub Issues](https://github.com/tenglvjun/mktero/issues)。修改运行时行为时，请运行上面的完整验证命令并为受影响的行为补充测试。请勿在 Issue、Pull Request 或日志中提交凭据、私密 PDF 或其他敏感信息。

## License

[MIT](./LICENSE) © 2026 Tony
