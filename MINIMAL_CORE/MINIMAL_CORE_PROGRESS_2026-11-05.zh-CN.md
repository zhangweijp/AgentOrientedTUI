# Minimal Core 整体进度与剩余工作估算

日期：2026-11-05。时间证据按 Asia/Shanghai 展示。

> 后续范围修订：项目所有者已明确取消 D3 历史消息迁移，不延期、不另包、不计剩余工作或准出条件。Batch 08 也已独立复核为 APPROVED。本文的原始工时分解保留作历史估算；原 Source/D3 合并预算不能继续作为历史迁移的派单或当前剩余工作依据，后续排期只统计仍有效的任务。

本文是负责人根据现有代码、计划、交付与复核记录形成的进度快照。它不新增实施授权，不替代任何批次的批准记录。本轮仅阅读、核对与估算，没有执行构建或测试，没有修改生产代码。

## 1. 结论：内部第一轮去重已取得实质成果，开发者可感知的简化仍是后续主体

**Batch 01–08 均已有负责人 APPROVED 记录。** Batch 09 按单独任务书推进 Source 统一；D3 历史消息迁移已取消，不能继续列为未完成项，也不能按批次数推算整体完成率。[S1][S2]

当前已经收敛了 Scope 的重复 owner、ledger、校验时钟与扫描，消除了多处终态/响应重复，并修复了 SDK 自动执行、历史加载和 IM 工具结果续跑等已确认问题。最直接影响应用作者体验的 SDK 接口简化、Ref 参数统一，以及真实 Source 的统一捕获尚未整体落地。现有历史消息读取与规范化保持，D3 迁移已取消。[S1][S3]

以下数字保留为取消 D3 前的原始范围估算，不作为修订后的新交付承诺：按原 MINIMAL 计划、采用较小的 SDK 作者接口方案估算，**剩余约 30–55 个活跃 Agent 小时**。该数字包括必要实现、测试、独立复核与通常返工，是工程预算，不是实测速度或交付保证。使用两个有清晰文件边界的执行 Agent 加一个负责人，实际经过时间可暂按 **20–40 小时**安排；等待用户验收、环境故障及新增范围另计。

若追加尚待冻结的显式 View 元数据、Observation 接替与刷新语义，另预留 **10–20 个活跃 Agent 小时**。不将其默认混入原计划，也不把 SRT 草案中的全部新概念视为必做。

## 2. 当前完成到哪里

### 2.1 已批准批次的实际贡献

| 批次 | 已完成的实质工作 | 本表不扩大到的范围 |
| --- | --- | --- |
| 01 | 唯一 Scope owner；ledger 内联；统一校验时钟、消除嵌套扫描；临时 Observation 释放；修复 R1/R2 | 不代表 Scope/Observation/Binding/Receipt 全部消失 |
| 02、04 | 共用终态字段规则和 Ordinary/Ref 响应构造；发送捕获减少；接收边界仍独立检查 | 不代表所有层的结果转换与参数验证均已统一 |
| 03、05 | SDK 不自动执行业务，Driver 保持执行所有权；删除死采集/路由分支并迁移行为测试 | 不代表五个真实 Source 已完成 getContext 迁移 |
| 06、07 | 历史加载共享同一在途 Promise；补齐 IM 结果续跑并保留 pending、stop 等原门禁 | 不代表新调度引擎或所有未知时序均已证明 |
| 08，已批准 | 删除普通工具 registration 的死 canonical 字段和 inputSchema 镜像，生产净删 2 行 | 后续独立复核已通过 42 项、严格类型、声明与 Core 轨迹；详见该批 REVIEW |

这些批次的批准范围分别绑定各自 patch，不等于已提交、发布或为未来组合候选完成验收。[S1][S2]

### 2.2 按原计划看，完成与剩余分布如下

| 工作面 | 判断 | 还缺什么 |
| --- | --- | --- |
| Runtime 状态所有权与资源管理 | 主要去重完成 | 保留有实际消费者的历史、lease、容量和关闭结算；不为净删而取消职责 |
| Runtime 结果与参数验证 | 部分完成 | R3 剩余转换归属；R4 最终 compiled input 校验与跨信任边界检查的分工 |
| Driver 执行可靠性 | 已确认风险已修复 | 保持现有 stop、禁用、单执行、连续结果与释放合同 |
| Source 统一 | 主体迁移未完成 | 五个真实 Source 的原子 getContext 与当轮执行身份；D3 已取消，现有历史格式、读取和规范化保持 |
| SDK 作者接口与 Ref | 主体未实施 | ToolUI 回传链退出、普通工具/Ref 工具合同统一、类型与四个 App 的共同迁移 |
| 最终候选准出 | 尚未完成目标范围的一次组合准出 | 当前构建与真实包消费、真实 IDE/Host 链路、代表性 Agent 编写任务及版本对应的验收 |

原里程碑 M2/M3/M4 已完成；M5/M6 部分完成；M7/M8 的主体和 M9 最终准出仍在后面。M0 的每批基线与证据方法已建立；M1 已确认的主要风险已处理。这是里程碑映射，不是按编号平均计算的百分比。[S1][S3]

当前源码也支持上述判断：五个 Host Source 仍分别提供 getMessages/getTools/executeTool；Driver 仍维护公开 getToolSource 所需 Map 和捕获执行器的 fallback；消息生产者仍有 result/output 双形态；useViewTypeTool 仍返回 ToolUI 并创建 tool-ref，SDK 仍导出对应类型与 useViewSnapshotTool。[S7]

### 2.3 已有工作不能重复算入剩余范围

历史清理报告已经记录主要 Runtime Legacy 执行链退出。旧 Source/Dispatcher/SnapshotRegistry/Fragment 并未作为备用执行链保留。现行独立 snapshot Hook 属于待统一的 Ref 合同，不能仅凭其名称把它再次算作 Legacy 清理。[S4]

2026-11-02 的记录明确保留所有者对当时完整 Host、真实模型与 Electron 的验收确认。该版本的验收事实有效；后续新候选需要按版本与行为变化确认覆盖范围，不能抹掉历史验收，也不能直接套用旧产物证据。[S5]

Ref 注册的 update/release 所有权、重复注册拒绝、正文保真、单 App 失败隔离及工具别名预检也已有修复。这些不是从零开始的待办。最终只核对真实残留和新候选，不再假定存在一个“大规模 Legacy 删除”工作包。[S6]

## 3. 原始工作量估算及范围修订

本节保留取消 D3 前的原始估算以便追溯：A 已完成，C 中的历史消息迁移已取消，不能继续计为当前剩余工作。原 C 项没有单独测量 D3 工时，本次不虚构精确扣减；后续按有效任务范围校准。以下原估算采用顶尖 Coding Agent、项目上下文和已有依赖可用、已有证据及测试可复用的假设。每项已经包含其必要测试、独立复核与通常的一轮修复；全量组合验收只在最后一项计一次。

| 工作包 | 可核对的完成结果 | 活跃 Agent 小时 | 主要不确定性 |
| --- | --- | ---: | --- |
| A. Batch 08 独立复核（已完成） | 已 APPROVED，不再计剩余 | 原估 0.5–1 | 当前剩余为 0 |
| B. Runtime 剩余收敛 | 每个结果转换和输入检查有明确归属；删除真实重复，保留必要边界检查 | 2–5 | R4 若改变可信工厂的现有坏输入行为，就不是等价删除；必要时保留原检查 |
| C. Source 统一（D3 部分已取消） | 按 Batch 09 统一捕获与执行身份；不迁移历史消息格式/读取边界 | 原合并估算 4–8；不继续作为 D3 预算 | 捕获时点、MCP 实例身份、异步更新与迟到响应 |
| D. SDK 最小作者接口及 App 迁移 | 删除 ToolUI 回传等非必要作者负担；四个 App、公开类型与示例一同迁移 | 6–12 | U6 与 SRT-01 路线需统一；不实施两套展示体系 |
| E. Ref 参数统一 | 一份参数声明派生调用合同；真实 Ref 容器与类型、资格和释放语义正确 | 8–16 | Core/Worker/SDK 跨层迁移、raw/effective input 区分、旧观察与失效身份 |
| F. 最终组合准出 | 当前组合构建、必要全量回归、真实 tarball 消费、IDE/Host 与 Agent 作者任务、负责人结论 | 4–8 | 集成缺陷、真实包路径与已验收版本差异 |

修订前逐项区间合计为 **24.5–50 小时**；A 完成和 D3 取消后，该合计仅作历史记录。另留约 5 小时超出各包常规局部修复的跨包整合与返工余量，采用便于规划的 **30–55 小时**区间。不会把执行 Agent 和复核 Agent 同时工作的时间错误当成经过时间。

方案收敛前提：原 MINIMAL U6 主张 Hook 只注册、返回 void，并用普通内容保留工具说明，不新建 ToolCatalog；SRT-01 草案则提出 ToolSet/AppTools/ToolRef/ToolCatalog。两者不能同时照单实施。本表按前者的简化方向估算，保留“静态合同与每 App 实例执行绑定分开”的必要目标，不预设必须引入后一套新名词。

计工边界：D 负责共同的 App 作者接口迁移与文档；E 只计 Ref 特有的剩余迁移，尽量与 D 在同一文件编辑中完成；F 主要计最终组合门禁、结果判读和验收准备，不重计前面定向验证；同一个缺陷的修复只记一次。若路线改为完整 SRT-01 新作者体系，应重新估算，不能沿用本表也不能简单叠加第二遍 App 迁移。

### 3.1 原始经过时间估算（非修订后新承诺）

- **单执行 Agent，负责人顺序介入：**约 30–55 小时连续有效工作窗口，交接等待另加。
- **两个执行 Agent，加一个独立负责人：**先冻结共同合同；Source 与 SDK/Ref 两条工作流在文件边界明确时并行。考虑共享文件、复核与最终集成，暂按 **20–40 小时经过时间**安排，不能直接除以三。
- **按每天 8 小时可持续工作窗口：**上述并行方案约 3–5 个工作日；这是小时换算，不是日历交付承诺。
- **同一天内完成全部剩余目标：**不作为可靠预算。范围明确的单个删除可以很快，但 SDK/Ref 的跨层行为与接口迁移尚未完成合同收敛。

这里的“活跃 Agent 小时”是所有执行与复核 Agent 的有效投入之和，包括读代码、编写、必要工具等待与审查，不含无人处理的交接空档。它不是模型推理 GPU 小时，也不是传统人日乘某个固定提速倍数。

### 3.2 更完整的产品合同，单列增量

若下一阶段明确要求显式 View type/kind、读取已提交投影的刷新时点、新 Observation 成功采用后旧调用/Ref 资格失效与持有数据释放，额外粗估 **10–20 个活跃 Agent 小时**。只计算这些新语义及专属验证，不重复计算现有 Ref 注册释放、App 基础迁移与完整准出工程。[S8]

原盘点同时选择两个范围时采用 **40–75 个活跃 Agent 小时**作粗预算；D3 取消后该数值同样保留为历史记录，不能作为包含取消项的新排期。SRT-01 的 ToolSet/AppTools/ToolCatalog 全套草案、泛化并发框架及容量重设计均未默认纳入。

“成为广泛采用的 LLM Agent Infra”还涉及真实第三方接入、作者体验反馈与长期维护，不能将一次代码改造的完成时间当成生态采用时间。

## 4. 估算依据及流程调整

### 4.1 最近小批次的时间证据

| 批次 | 执行基线到最终交付 | 负责人记录窗口 | 解读 |
| --- | ---: | ---: | --- |
| 05 | 2 小时 44 分 | 23 分钟 | 中间另有约 88 分钟交接间隔 |
| 06 | 28 分钟 | 36 分钟 | 两段重叠，不能相加；整个已记录窗口约 36 分钟 |
| 07 | 13 分钟 | 12 分钟 | 中间另有约 16 分钟交接间隔；总窗口约 41 分钟 |

来源为各批 baseline.json、final-delivery.json、owner-review/review-start.json、owner-review/final-verification.json 的实际时间字段。它们是记录窗口，不保证连续工作，也不一定包括开始记录前的方案分析；没有用它们宣称某个型号的模型基准。[S9]

代表性的候选测试进程约 1.4–1.7 秒，Batch 07 严格检查约 2.2 秒。验证进程本身不是这些微批的主要耗时。阅读、决策、编写、证据整理、工具调用和交接需要分别考虑；现有数据不足以断言“文档耗时一定大于编码”。不能把三行通知修复的速度线性外推到 SDK/Ref 迁移。[S9]

### 4.2 接下来减少拆批成本，并保持独立复核

1. Batch 08 已完成负责人复核；下一步执行已下发的 Batch 09 Source 任务。
2. 下一轮按 Batch 09 完整收口 Source 捕获与执行合同；D3 历史消息迁移已取消，不安排后续包。SDK 作者接口与 Ref 合同继续先统一方案，再按真正的跨层边界实施。
3. 对共享文件明确唯一执行负责人；其他 Agent 可并行做只读审阅、独立测试设计与互不冲突的迁移。不能让多个 Agent 同时覆盖同一工作树内容。
4. 一包建立一次实际基线，保存真实 preimage、独立 patch 与必要证据。复用有效验证，最终只做一次目标范围的组合准出；不为每个死字段重复建立一整套仪式。

这改变的是批次粒度和交接方式，保留并行修改保护、真实行为验证与独立复核。历史报告不倒改，批准记录仍各自绑定对应 patch。

## 5. 怎样判断这一轮真正完成

- **行为保持：**View 最新有效快照、Tool 仅发起操作、动态可见性、执行门禁、单次业务执行、旧身份拒绝及关闭等待等核心行为无意外变化；应用业务判断仍由应用负责。
- **作者负担下降：**Agent 可用公开 SDK 完成代表性 App；不需要理解内部 ledger、重复 owner 或 ToolUI 回传技巧；必要概念有清楚归属。
- **迁移完整：**真实 Source、四个 App、公开类型、示例与文档同一合同，不以保留第二套执行链换取表面兼容。
- **候选证据成立：**测试与真实包消费对应最终构建；既有历史证据被正确复用，新增行为得到独立验证。未执行范围明确列出。
- **验收对应版本：**负责人形成整体结论；涉及新行为的用户验收依据最终候选组织。历史已验收版本不被重复列为未验收，也不被用来替代新候选证明。

## 6. 可追溯来源

以下路径均位于用户指定的远端项目。本次优先以批准记录与当前源码判断状态；设计稿仅用于识别目标，历史报告中的旧待办不自动当作当前待办。

- **[S1] 批次批准记录：**`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE_BATCH_01_REVIEW_02.zh-CN.md`；同目录 `MINIMAL_CORE_BATCH_02_REVIEW.zh-CN.md` 至 `MINIMAL_CORE_BATCH_07_REVIEW.zh-CN.md`。
- **[S2] Batch 08 交付与批准：**`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE_BATCH_08_REPORT.zh-CN.md`；对应 patch 报告指纹 `67b91075776dbc99caefda16166231adc9d17bbede4a5e0dc6c59b1cd412966f`。后续独立批准见同目录 MINIMAL_CORE_BATCH_08_REVIEW.zh-CN.md；本快照最初编写时尚未复核，后续状态在本次范围修订中更新。
- **[S3] 原范围：**`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE_REFACTOR_PLAN.zh-CN.md`，R1–R6、D1–D4、U0–U7 与 M0–M9。
- **[S4] Legacy 历史：**`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/AOTUI_CLEANUP_PRO_REVIEW_REPORT.2026-11-03.zh-CN.md`，第 1、3、4、5 节。
- **[S5] 所有者历史验收：**`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/docs/core-cleanup-pass2-2026-11-01.zh-CN.md`，2026-11-02 项目所有者验收确认。
- **[S6] 已完成边界修复：**`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/AOTUI_PRO_REVIEW_REPAIRS.2026-11-03.zh-CN.md`。
- **[S7] 当前生产入口：**`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/host/src/adapters/host-driven-source.ts`、`host/src/adapters/system-prompt-source.ts`、`host/src/im/im-driven-source.ts`、`host/src/mcp/source.ts`、`host/src/skills/skill-driven-source.ts`、`host/src/core/message-service-v2.ts`、`agent-driver-v2/src/core/agent-driver-v2.ts`、`sdk/src/hooks/useViewTypeTool.ts`、`sdk/src/tools/view-type-tool.ts`、`sdk/src/index.ts`。短路径均相对于该项目根目录。
- **[S8] 作者 API 与扩展边界：**`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/SRT-01_SINGLE_DECLARATION_PLAN.zh-CN.md` 仍为拟议方案；其 Scope 明确不含 Ref 统一、显式 ViewType、Observation adoption 等。它与原计划 U6/M8 具有重叠，展示路线还存在分歧，不能重复实施或计工。增量工时是负责人估算，不是该文件的完成记录。
- **[S9] 时间元数据：**`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-05/`、`minimal-core-batch-06/`、`minimal-core-batch-07/` 下的 `baseline.json`、`final-delivery.json`、`owner-review/review-start.json`、`owner-review/final-verification.json`；命令耗时来自 `final-driver-tests.json`、`final-host-mcp-tests.json`、`candidate-tests.json`、`candidate-regression.json`、`candidate-strict.json` 等对应批次原始记录。
