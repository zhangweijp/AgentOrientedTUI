# View 全链路完整交付：独立验收

2026-11-08。**CHANGES_REQUESTED，合并修订清单仅 R1 一项。** 已完成整项差异、实际源码、迁移与必要运行验证的独立复核。显式元数据、唯一包装、四 App 接线及现有生命周期行为均有验证依据；正文 CRLF 的 XML 往返保真仍未满足本任务准出，暂不采用该候选。执行者修订整份交付后再次交审，其他无变化证据继续复用。

**R1／P2：正文中的回车在标准 XML 消费时丢失。** [最终消息边界](../.tmp/view-pipeline-20261108/candidate/runtime/src/adapters/view-message.ts) 的正文编码处理了 `&`、`<`、`>`，但没有保留 XML 解析会规范化的回车。负责人在全新正常安装的最终 Runtime 包上，调用公开 `buildViewMessageMarkup`，再使用本批测试已经采用的 JSDOM DOMParser 解码：

```text
输入正文："    first\r\nsecond  \r\n"
解码正文："    first\nsecond  \n"
```

同样内容使用 LF 时通过。回车在正常 XML 解析中消失，调用没有报错；这使原样文件正文与候选承诺的“解码后恢复原 Markdown”不同，也与 Host 当前直接解码字符串的行为不一致。本任务明确要求保留原样正文的空白和换行，应在现有唯一消息边界解决，不要求 App 处理或新建编码层。[真实结果](../review-evidence/view-pipeline-owner-review-20261108/xml-newline-check.json) · [复现脚本](../review-evidence/view-pipeline-owner-review-20261108/xml-newline-check.mjs)。这是已复现的本任务保真遗漏，不归入 SRT-10。

**实际范围与职责评估。** 最终 patch 为92路径，84修改、6新增、2删除，+606/-632行。SDK 复用现有 ViewSnapshot kind，要求 id/type/kind；Runtime 只读 View 根元数据，删除从实例 ID、后代角色和旧展示属性推断的路径；最终 Runtime 呈现 helper 承担编码与外壳，Host 预览解码；App 只补明确元数据，不承担正文修补。旧 Source 两份测试副本退出后，当前跨包测试保留相应隔离、空 View、调用与清理断言。没有新依赖、管理器或平行语义内核；Ref 参数解析、Driver 回合和资源策略未修改。

多行 pre 保真和动态围栏已有实现被保留，本轮增加行内 code 的边缘空白／反引号处理，不能把所有历史修复归为本批新增。公开变化包括 View 字段必填、最终外壳 kind 和正文 XML 编码，文档及消费者已随候选迁移；真实模型与最终 Semantic 验收尚未进行。

**交付身份。**

| 对象 | SHA-256 |
| --- | --- |
| VIEW_PIPELINE.patch | `cbfc302cdc8486b351e6c6c8a31215b085db477f63fcfbd2311f4bcde402d919` |
| final-delivery.json | `b7e9e1c082afef4082d136eb58edb8d1c4fae2d5f560fb247b447fd3965bcc95` |
| 候选源码清单 | `122864e603589926652b28532c0befb4ab7d72b5554d5be028c42a25bc180008` |
| Runtime tar | `9781ed868f3adf2555a1e82987af1ba759f12a9164a16dd9a8f962ce90a286cd` |
| SDK tar | `44d021837e7d0eebad2b9720c4e57c762a0fe559900b362d94fe9f986a578333` |
| Adapter tar | `92f28bd14542959efcd6c2bf42aab67df61eaa86320fe104ba2e72152025341e` |
| Driver tar | `190d9e9031affcc44a67ce97146dd6c49754780d3f09e2f073f9678176963feb` |

负责人核对900份基线、905份候选和535份交付文件，实际重放92路径增量，结果905份全等。900份基线以外的一份 Token Monitor Root 原文只用于存量静态测试，单列保留，不作为该 App 迁移验收。重建与测试之后源码没有漂移。[身份与重放](../review-evidence/view-pipeline-owner-review-20261108/input-verification.json) · [测试后核验](../review-evidence/view-pipeline-owner-review-20261108/tested-source-final.json)。

**负责人独立运行。** 源码工作目录 `/private/tmp/aotui-view-owner-source-jll1lysd` 来自实际重放；源码构建复用现有第三方依赖，四个内部包均指向自己的工作目录。另在 `/private/tmp/aotui-view-owner-consumer-142cxzvi` 以正常 frozen/offline 安装消费四个最终 tar，没有源码替代正式包。

| 验证 | 独立结果 |
| --- | --- |
| 原 run.sh 构建前缀 | 九模块通过，未启动 Electron |
| Runtime View／提取／包装 | 45/45 |
| SDK 默认回归 | 183/183 |
| Adapter 默认回归 | 46/46 |
| 跨包集成与真实 Worker | 31/31 |
| Host 预览 | 11/11 |
| SDK 静态合同 | 通过 |
| 正常包严格公开类型及四份示例 | 通过，strict／exactOptionalPropertyTypes／skipLibCheck:false |
| 正常包运行 | 原链路8次调用、发布文档示例4次调用通过；包含两种 Producer 对照、正文、Ref、更新采用、关闭重开与资源释放 |
| 构建与安装身份 | 重建447份 dist 与最终 tar 一致；正常安装483份包文件与 tar 一致 |

316项相关测试不包括静态类型和上述12次实际调用，也不与执行者成绩重复相加。[构建](../review-evidence/view-pipeline-owner-review-20261108/build.json)、[回归命令](../review-evidence/view-pipeline-owner-review-20261108/regression-commands.json)、[正常消费者命令](../review-evidence/view-pipeline-owner-review-20261108/public-commands.json)、[包身份](../review-evidence/view-pipeline-owner-review-20261108/package-identity.json)。

**边界与未覆盖风险。** 执行者 Runtime 全量为2046通过、3项既存 Worker 安装诊断失败；负责人核对其基线／候选记录与范围，未冒称独立重跑全量。SRT-10诊断、Driver完整第三方严格声明、原生LSP继续单列。无真实模型、Electron人工验收或共享采用。Clean 的 Ref 增量另行交付，两个候选最终集成仍需统一入口验证，不整目录覆盖。除了 R1，本次完整复核没有提出其他阻断项。

**统一修订范围、准出与 Codex Prompt。** 本次反馈作为完整任务的一次集中验收，不重开逐阶段审批。执行者自行修复 R1，并补真实正文的回归，更新受影响产物与最终交付身份。现有316项、构建、迁移与包消费证据对未改输入继续有效，只复跑修复影响的包装、预览和真实消费者链，不重复无关矩阵。

> 按本报告 R1 修复现有唯一消息边界的回车保真遗漏，覆盖 CRLF 与正文中的独立 CR；普通 LF、首尾空白、字面实体和元数据编码继续正确。证明 SDK／普通 TS 发布的原样正文经实际消息消费及 Host 预览得到一致内容，保留现有 Ref／采用／关闭行为。不要引入新编码层或让 App 预处理。自主完成代码、必要回归、受影响包构建和真实消费，保留原失败及已验证输入，更新整份交付后一次交审；不扩入 SRT-10 或 Clean 的 Ref 合同。
