# Mistral OCR 用于 PDF 转 Markdown 的适用性分析

> 调研日期：2026-09-01
> 结论对象：Mistral OCR 4.1 作为 Mktero 的并列解析提供商
> 资料范围：Mistral、MinerU 官方文档及 Mktero 当前代码

## 结论

Mistral OCR 4.1 **适合将学术 PDF 解析为 Markdown**，值得作为 Mktero 与 MinerU 并列的第二解析提供商接入。它不需要用户拥有 MinerU 账号，能覆盖一类明确的用户需求；两者应作为可配置方案共存，而不是设计成迁移替换。

它与 Mktero 的核心需求较匹配：逐页返回 Markdown，能够识别公式、表格、图片、caption、参考文献和多栏版面；可以返回图片 Base64；也能返回有阅读顺序和坐标的版面 block，用于构造 Markdown 到 PDF 的定位信息。官方当前列出的单文档上限为 50 MB、1,000 页，实时 OCR 标价为 4 美元/1,000 页，通常足以覆盖论文阅读场景。[1][2][5]

真正的风险不在“能否输出 Markdown”，而在并列 provider 的运行语义：Mistral 同步 OCR 没有 MinerU 任务 ID，不能沿用当前的任务恢复机制；其 block、图片和表格格式需要新的安全适配层；官方也没有公布足以代替 Mktero 实测的 OCR 4.1 质量、延迟或 SLA 承诺。因此应保留 MinerU 现有链路，同时新增可配置的 Mistral provider，并让用户按账号、隐私和文档限制选择方案。

## 能力与限制

| 维度 | Mistral OCR 4.1 | 对 Mktero 的判断 |
|---|---|---|
| 模型版本 | 当前固定模型 ID 为 `mistral-ocr-4-1`；`mistral-ocr-4` 和 `mistral-ocr-latest` 是可移动别名 | 应固定 `mistral-ocr-4-1`，避免缓存结果在别名升级后静默改变 |
| 调用方式 | 同步 `POST /v1/ocr`；输入可为公开 URL、Base64 data URL，或先上传到 Files API 再引用 | 作为独立 provider；本地 Zotero PDF 宜优先评估直接 Base64，避免公开 URL 和 Files 生命周期 |
| Markdown | `pages[]` 中逐页返回 `markdown` | 可按 `page.index` 排序拼接，并在页间插入稳定分隔符 |
| 版面结构 | 可返回按阅读顺序排列的 block、类型和边界框；页面含尺寸信息 | 足以适配 Mktero 的 source map，但匹配质量必须实测 |
| 公式 | 官方示例在 Markdown 中保留 LaTeX 数学表达式 | 与当前 Markdown 阅读器方向一致，复杂公式仍需测试 |
| 表格 | 默认可内联为 Markdown，也可通过 `table_format` 分离为 Markdown 或 HTML | 首版应优先测试内联 Markdown；HTML 模式需经过现有安全模型处理，不能直接插入 DOM |
| 图片 | `include_image_base64` 可返回图片数据；Markdown 使用图片占位符引用 | 可转成 Mktero 本地 assets，但必须限制单图、总量和解码后大小 |
| 页眉页脚 | 可单独提取 header/footer，并从正文中分离 | 有利于减少跨页噪声，建议显式配置并纳入 profile |
| 置信度 | 可返回页级、block 级或词级置信度 | 可用于诊断或低质量提示，不宜未经校准就设硬阈值 |
| 页选择 | 支持零基页码数组和范围 | 可用于重试或预览，但 Mktero 首版仍应保持整篇转换语义 |
| 输入上限 | 官方列出 50 MB、1,000 页 | 比 MinerU 当前文档的 200 MB、200 页更适合长文档，但更不适合大体积扫描件 |
| 语言 | 官方当前列出 40 多种核心 OCR 语言及若干“表现良好”的额外语言 | 中英论文场景有基础支持；旧发布稿的宽泛语言宣传不能代替当前语种实测 |
| 价格 | 实时 OCR 为 4 美元/1,000 页；带 annotation 的页面为 5 美元/1,000 页；Batch 文档说明可享 50% 折扣 | 50 页论文的实时标价约 0.20 美元，不含税费、地域附加费及失败重试影响 |

能力、请求字段和输出结构见 OCR 指南、接口定义、OCR 4.1 模型卡及 annotation 文档。[1][2][3][7] 模型别名规则见模型生命周期文档。[4] 价格见官方定价页。[5]

### 输出结构的适配价值

`/v1/ocr` 的响应不是一个单独 Markdown 文件，而是结构化的 `pages[]`。每页可包含：

- `index`、`markdown`、`images`、`tables`、`hyperlinks`；
- `header`、`footer` 和页面 `dimensions`；
- 可选 confidence 数据；
- 可选 `blocks`，类型包括文本、标题、列表、表格、图片、公式、caption、代码、参考文献、页眉和页脚等。

这比只有 Markdown 文本更适合 Mktero：图片可以落为本地资源，block 坐标可以参与 PDF 跳转，header/footer 可以从正文中去重。但 API 返回的 Markdown、block 文本和占位符之间未必能逐字一一对应，不能仅凭“有 bbox”就假定定位准确。适配器需要定义匹配规则，并用点击跳转测试验证。

### 同步与 Batch 的取舍

交互式 Zotero 阅读场景更适合同步 `/v1/ocr`：一次请求即可得到结果，用户关闭标签页时 Mktero 可以中止本地请求。问题是官方接口没有公开承诺服务端取消、请求幂等键或超时后的计费去重；网络在响应前中断时，自动重试可能重复计算或计费。

Batch API 能提供异步 job、状态查询、结果下载和取消，并有 50% 价格折扣，但它更适合离线批处理。它增加了任务和文件生命周期管理，而且 Batch 文件不在 Zero Data Retention（ZDR）覆盖范围内，不适合作为 Mktero 单篇交互解析的默认路径。[6][11]

## 隐私、存储与地域

PDF 内容、API token 和 OCR 结果都属于敏感数据。对 Mktero 来说，推荐的隐私优先路径是：直接向 `/v1/ocr` 发送 Base64 PDF、使用正式 GA 模型，并在组织确有要求时申请获批的 ZDR。

官方隐私控制文档说明，API 数据默认不用于训练，但相关条款仍保留用户主动选择加入、反馈、订单约定以及 Labs/Preview 产品等例外。OCR 4.1 是 GA 模型，生产使用应固定该模型而非实验模型。[3][10][14]

公开隐私控制页面没有为所有无状态 `/v1/ocr` 请求给出一个可直接依赖的统一默认保留 TTL；默认 API 数据处理和组织级控制应以适用条款、控制台设置及 Mistral 的书面确认为准。获批付费计划的 ZDR 覆盖 `/v1/ocr` 时，请求输入输出不会在生成所需时间之外被存储或记录；但 ZDR 明确不覆盖 `/v1/files`、Batch Files 等有状态能力。[10][11]

Files API 会让 PDF 在 Mistral 侧成为可复用文件对象；已知限制页面写明上传文件保留 30 天，除非更早删除。若采用 Files API，仍应显式删除文件、处理失败清理，并在产品文案中说明存储行为；不能把 Files TTL 外推为无状态 `/v1/ocr` 请求的保留规则。[10][11]

Mistral 提供欧盟和美国区域推理端点，标价有 10% 附加费。区域推理限制处理位置，但不等同于整个控制面的完全地域隔离；区域端点也不提供 Files API 和 Batch。部署前还需通过对应区域的 `/v1/models` 验证 OCR 4.1 的实际可用性。[12]

直接 Base64 也有工程成本：编码后请求数据通常约为原 PDF 的 4/3，并会在 Firefox/Zotero 中产生额外字符串和解析内存。接近 50 MB 上限的 PDF 需要专门测量内存峰值，不能只按原始文件大小估算。

## 与 MinerU 的比较

下表只比较官方文档可验证的产品和接口属性，不推断两者真实 OCR 准确率高低。质量高低必须由同一组 PDF 实测。

| 维度 | Mistral OCR 4.1 | Mktero 当前 MinerU Precision API |
|---|---|---|
| 主流程 | 单次同步 OCR；另有 Batch | 提交、上传、轮询、下载 ZIP 的异步任务 |
| 结果 | 每页 Markdown + 结构化图片、表格、block、坐标 | ZIP 中的 Markdown、图片和结构 JSON；还可选择其他导出格式 |
| 文档上限 | 50 MB、1,000 页 | 200 MB、200 页 |
| 表格/公式 | 原生支持；表格输出格式可选 | 可配置启用表格和公式识别 |
| 复杂版面 | 官方描述支持文档结构和阅读顺序 | 官方描述支持多栏、表格、公式、图表、图片和扫描件 |
| 任务恢复 | 同步接口无公开任务 ID | 当前 Mktero 会保存 batch ID，能够恢复轮询 |
| 取消 | 可取消本地 HTTP 请求；无公开服务端取消语义 | Mktero 可停止本地流程，并保留任务供后续恢复 |
| 实时价格 | 4 美元/1,000 页 | 当前官方 API 文档未给出可直接进行同口径比较的公开美元页价 |
| 隐私选项 | `/v1/ocr` 可在获批后使用 ZDR；Files/Batch 不适用 | 需按 MinerU 当前服务条款和部署区域单独评估 |

MinerU 官方 API 文档显示，Precision API 支持 `pipeline`、推荐的 `vlm` 和 MinerU-HTML，单文件上限为 200 MB、200 页，批量最多 200 个文件；结果下载为 ZIP，并可包含 Markdown 和 JSON。[17]

Mistral 的优势是同步接口简单、逐页结构丰富、价格公开，并且单文档页数上限较高；对没有 MinerU 账号的用户，它还提供了独立可用的服务入口。MinerU 对 Mktero 的现实优势则是现有实现已经围绕其异步任务、ZIP 和 `content_list` 完整打磨，而且 200 MB 大小上限更宽。两者应作为并列方案按用户条件选择，谁的论文阅读顺序、公式、表格和图像质量更好，仍需同条件实测。

## Mktero 集成影响

当前 Mktero 已有一个可利用的 provider 边界：`MarkdownDocumentService` 依赖 extractor；但组合根仍直接实例化 `MinerUConversion`、`MinerUClient` 和 `MinerUDocumentExtractor`。[18] 为了让 MinerU 和 Mistral 并列可选，Mistral 接入不应修改 MinerU 适配器内部来兼容两套结果，而应新增独立 provider/client/extractor，并在组合根按配置选择。

### 必需改造

1. **请求层**：用注入的 `fetch`/AbortController 调用 `/v1/ocr`，不要假定官方 TypeScript SDK 可在 Firefox 115 的 Zotero 特权环境中正常打包运行。实现 429、500、502、503、504 的有限重试；429 尊重 `Retry-After`。[8][9]
2. **结果适配**：按页码稳定拼接 Markdown，规范化图片和表格引用，保留页级信息。Mistral 结果不得经过 MinerU 专用的文本流、双栏和 figure panel 重排逻辑；这些逻辑目前集中在 `prepareMinerUResult`。[19]
3. **图片处理**：将受信字段中的 Base64 解码为 `{ path, mimeType, data }`，但继续把响应当成不可信输入。复用或抽取当前 ZIP 路径、MIME、单资源 25 MB、总资源 150 MB 等预算思想；在解码前验证 Base64 长度，防止先分配超额内存。[20]
4. **PDF 定位**：显式请求 blocks，将像素坐标按页面宽高转换为 Mktero 所需的 0–1000 bbox，再把 block 内容与最终 Markdown 范围匹配。当前 source map 验证器要求四个有限坐标均在 0–1000 且构成正面积矩形。[21]
5. **缓存隔离**：缓存 profile 至少包含 provider、固定模型 ID、请求选项、表格模式、header/footer 策略和适配器版本。当前 profile 只描述 MinerU batch/file/source-map 选项，不能复用为 Mistral 缓存身份。[22]
6. **生命周期**：关闭标签页和扩展 shutdown 仍需 abort 本地请求。同步 OCR 不应写入 MinerU pending-task store；UI 也不应显示“恢复 MinerU 任务”等错误状态。
7. **偏好与文案**：新增 provider、Mistral API key 及隐私说明时，要同步修改默认偏好、配置、偏好页、i18n、测试和 README，并明确 token、缓存 Markdown/图片及服务端处理方式。

### 建议的首版请求策略

- 模型固定为 `mistral-ocr-4-1`；
- 使用直接 Base64 `/v1/ocr`，不使用公开 URL；
- 显式启用 blocks、图片 Base64 和独立 header/footer；
- 表格先以默认内联 Markdown 为基线，再与分离 Markdown 模式做 A/B 测试；
- 对响应 JSON、页数、Markdown、block 数、单图、图片总量设置明确预算；
- 限制重试次数，并把“请求已发送后响应不明”的重复计费风险记录在日志和测试设计中，但不得记录 PDF、token 或原始认证响应。

## 试点验收标准

建议用 20–30 篇可合法处理的真实论文做 MinerU/Mistral 盲测，覆盖：原生 PDF 与扫描件、中英混排、双栏、复杂表格、公式密集、多 panel figure、重复页眉页脚、老旧或轻微损坏的 PDF，以及接近尺寸限制的文档。

验收不应只看 Markdown 是否“像论文”，至少记录：

| 指标 | 建议测量方法 |
|---|---|
| 阅读顺序 | 对正文段落、脚注、双栏切换和跨页续接逐项标注错误 |
| 标题与列表 | 比较层级、编号和列表边界 |
| 公式 | 抽样比较 LaTeX 可渲染性与符号、上下标、矩阵正确性 |
| 表格 | 统计行列结构、合并单元格、表注和跨页表错误 |
| 图片 | 统计提取完整率、占位符匹配率、caption 关联和多 panel 顺序 |
| PDF 定位 | 随机点击 Markdown 文本、公式、表格和图片，统计正确页与 bbox 命中率 |
| 性能 | 记录端到端 p50/p95、超时率、Zotero 峰值内存和 UI 可取消性 |
| 成本 | 按成功、失败、超时后重试分别核对实际账单 |
| 隐私 | 验证所用 endpoint、区域、ZDR 状态及 Files/Batch 未被意外调用 |

只有在核心阅读顺序、公式/表格、图片和 PDF 定位均达到既定阈值，且性能与费用可接受后，才应决定默认 provider 或推荐顺序；无论默认选择如何，MinerU 和 Mistral 都应保留为可配置方案。试点之前不建议声称某一方的识别质量优于另一方。

## 尚未从公开资料确认的事项

- OCR 4.1 在 Mktero 目标论文集合上的准确率，以及可复现的当前 benchmark 方法；
- 托管 `/v1/ocr` 的公开延迟分布和 SLA；
- 组织的实际 OCR pages/minute 数值，官方仅说明在 Admin Panel 查看组织配额；
- 同步请求超时或断连后的幂等、重复执行和计费语义；
- Files 对象可依赖的统一自动删除 TTL；
- OCR 4.1 在特定美国/欧盟账户和区域端点的实时可用性；
- 图片 Base64、整个 JSON 响应体及 block 数量的公开硬上限。

这些未知项中，质量、内存和超时重试语义会直接影响是否适合设为默认解析器，应优先验证。

## 最终建议

**接入，作为与 MinerU 并列的可选 provider。** 这能直接满足没有 MinerU 账号、但已有 Mistral API 账号的用户。技术上，Mistral OCR 4.1 已覆盖 Mktero 从 PDF 到 Markdown、图片和 PDF 定位所需的主要原始信息；价格和文档上限也具有吸引力。工程上，它需要独立适配器、provider 选择、独立缓存身份和不同的生命周期处理。产品上，应让用户明确选择或配置各 provider，而不是要求所有用户迁移到同一个服务。

## 资料来源

以下均为官方一手资料，访问日期为 2026-09-01。

1. Mistral AI, [Basic OCR](https://docs.mistral.ai/studio/document-processing/basic_ocr)
2. Mistral AI, [OCR API endpoint](https://docs.mistral.ai/api/endpoint/ocr)
3. Mistral AI, [Mistral OCR 4.1 model card](https://docs.mistral.ai/models/ocr-4-1)
4. Mistral AI, [Model lifecycle](https://docs.mistral.ai/inference/model-lifecycle)
5. Mistral AI, [Pricing](https://docs.mistral.ai/inference/pricing)
6. Mistral AI, [Batch processing](https://docs.mistral.ai/studio/batch-processing)
7. Mistral AI, [Annotations](https://docs.mistral.ai/studio/document-processing/annotations)
8. Mistral AI, [Error glossary](https://docs.mistral.ai/resources/error-glossary)
9. Mistral AI, [SDKs](https://docs.mistral.ai/resources/sdks)
10. Mistral AI, [Privacy and data controls](https://docs.mistral.ai/admin/monitor-comply/privacy-data-controls)
11. Mistral AI, [Zero Data Retention](https://docs.mistral.ai/admin/monitor-comply/zero-data-retention)
12. Mistral AI, [Regional inference](https://docs.mistral.ai/inference/regional-inference)
13. Mistral AI, [Usage limits](https://docs.mistral.ai/en/admin/billing-usage/usage-limits)
14. Mistral AI, [Commercial Terms of Service](https://legal.mistral.ai/terms/commercial-terms-of-service)
15. Mistral AI, [Data Processing Addendum](https://legal.mistral.ai/terms/data-processing-addendum)
16. Mistral AI, [OCR languages](https://docs.mistral.ai/resources/languages#ocr)
17. MinerU, [MinerU API 文档](https://mineru.net/apiManage/docs)
18. Mktero, [`src/bootstrap.js`](../../src/bootstrap.js)
19. Mktero, [`src/mineru/mineru-result.js`](../../src/mineru/mineru-result.js)
20. Mktero, [`src/mineru/zip-markdown.js`](../../src/mineru/zip-markdown.js)
21. Mktero, [`src/core/markdown-source-map.js`](../../src/core/markdown-source-map.js)
22. Mktero, [`src/mineru/parser-profile.js`](../../src/mineru/parser-profile.js)
