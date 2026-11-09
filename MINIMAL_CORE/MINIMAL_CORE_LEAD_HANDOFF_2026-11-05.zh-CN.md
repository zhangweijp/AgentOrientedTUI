# AOTUI Minimal Core：接任技术负责人交接手册

> 交接快照：2026-11-05T06:14:13Z。
> 项目：/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI
> 状态：管理职责移交；本文不是新架构批准、代码实施或 Semantic 验收。
> 上级负责人保留产品方向、重大行为/API 变更、发布及最终用户验收权。接任 Coding Agent 负责日常组织、独立复核、节奏与升级；Codex/其他执行 Agent 写代码。

## 1. 这项清理的真正目标

构建干净、简单、强大、稳定的 AOTUI Infra，使 Agent 能使用 App，也能基于 SDK 写出正确 App。

- 使用者：App 将当前状态投影为 XML + Markdown 的 View，以 User Message 进入模型上下文；不等于 App 可以任意 CRUD 用户聊天历史。
- 作者：Agent 主要需要 App、View、Tool 三个概念；Ref 是参数能力；持久化、生命周期按需使用。不要强迫作者理解 Scope、Observation、Binding、Receipt、Worker 传输等内部术语。
- 动态能力：Tool 按 App + ViewType 注册和激活；同类 View 共享一份普通 Tool。具体文件、目标版本、权限和业务前提由 App 校验，Runtime 不能猜测业务参数。
- 读写分离：Tool 发起操作、返回简短结果/恢复提示；文件正文与主要业务数据进入 View。当前上下文同一逻辑 View 只有一份最新有效快照。
- 稳定语义：模型拿到的一轮 View、Ref、Tool 来源相容；旧 App 实例、旧工具激活和旧 Ref 不会因同名被无声转接；必须区分已执行、未执行、部分副作用、结果未知、投影失败及实际资源释放。
- Infra 边界：Runtime/Core 管提交、观察、调用资格、有界资源、回收与真实执行；SDK 管声明与组件生命周期接线；Adapter 管投影；Driver 管模型回合、串行执行/stop/释放；Host 管会话、历史、配置与策略；App 管领域真相和外部资源。

长期主义不是更多抽象。每项简化必须说明：删除什么重复状态/解释/分支？哪个现有 owner 继续承担必要职责？什么真实行为证明无损？禁止以简单为名把框架应有的保证丢给每个 App。

决策优先级：用户当前明确要求 > AGENTS.md > 已批准合同与批次决定 > 当前已授权 Batch 任务书及修订 > MINIMAL_CORE_REFACTOR_PLAN.zh-CN.md > deepseek_review.md 中历史 TODO / SRT 草案。先读 .agents/skills/minimalist/SKILL.md；YAGNI、复用现有代码、标准库、无新依赖、删除优先。发现冲突标明“目标/实现/提案”，不要拿旧文档抵消新用户决定。

## 2. 历史批次状态：01–08 已批准

以下是历史负责人批准的批次身份，并不声称所有批次原始材料今天仍存在，也不自动覆盖将来候选版本。

| Batch | 已批准的成果 | 批次 patch SHA-256 |
| --- | --- | --- |
| 01 | ledger 内联、单 Scope owner、单次扫描、临时 Observation 释放 | 0773b60d36298ae8eadcbb11479c854ebc95267694c395f60af092b076c9b132 |
| 02 | Core/Worker 终态字段共用单一规则 | e900e643b2bbb112db375df54e5dfb43abd7ad8be72507dbf3f73be95f4b3b00 |
| 03 | 模型 SDK 不再执行 Source 工具；Driver 唯一副作用入口 | 96e25335169f17c8595e7671535c9d5bcd79a7f4cae713d5b38c42b907f7049a |
| 04 | Ordinary/Ref 响应发送端捕获一次，接收端独立校验 | a0a69155bc9e349a2caf6b5fad3f9de7e8cee0382b4676eeb62a2c164ccb8052 |
| 05 | 删除 Driver 私有死方法和执行后备分支 | 1ea3c6ef2827ab2acc1bed0911ddff8f4d0f3b5caf1975307d3f798ec5f98a30 |
| 06 | IM historyLoading Promise 消除并发历史初始化漏洞 | 7c8ae04a422217fe9c2a2da2b1d357d98c9ec2d8cc77877b7a1a08dd0ad037fe |
| 07 | IM 工具结果保存后按 pending 通知续轮 | 348c7d28df69cbfc163da161beb26927fab1cca703933b5e6d3864a20204ab93 |
| 08 | 删除普通 Tool registration 的无用 canonical 与 Schema 镜像 | 67b91075776dbc99caefda16166231adc9d17bbede4a5e0dc6c59b1cd412966f |

大规模 Runtime Legacy 主执行链此前已退出，历史用户对旧版 Host/真实模型/Electron 曾确认验收；这不能替代新候选的版本绑定测试，也不能成为再次“全仓 Legacy 清理”的理由。

**证据治理特别注意：**Batch 09 开工后并行文件操作曾导致部分旧批次根目录报告、review 与 review-evidence 目录内容从原路径消失。交接时 batch-09/historical-protection-drift.json 记录了约 963 条历史证据路径缺失，文件实际状态需重新查。不要擅自恢复、删除、归罪执行者；保留缺失清单、原有哈希和时序，区分“证据不可读”与“代码有回归”。若验收所需原始证据不可恢复，及时向上级升级，不能把后来重建冒充开工原件。

## 3. 当前唯一正在执行的工作：Batch 09

权威任务书：MINIMAL_CORE_BATCH_09_TASK.zh-CN.md
交接时任务书 SHA-256：72a4440e03e7b31b9ebdbdef3cede1c6877677745b0b69e3b653f5ce7ee7871a
任务书状态：AUTHORIZED_FOR_IMPLEMENTATION。执行者已修改候选源码并产生测试/语义类型/工厂等价/包消费记录，但在交接快照时尚未有最终 MINIMAL_CORE_BATCH_09_REPORT.zh-CN.md 或 MINIMAL_CORE_BATCH_09.patch。接任第一步重新核对新文件及状态，不要把执行中的候选当成已批准代码。

Batch 09 是一个完整 Source 合同包：五个真实 Host Source（Host、SystemPrompt、MCP、Skill、IM）统一到既有 getContext；Driver 退出 split Source 和 Source executor fallback；保留本轮 Context 一起捕获消息、工具、执行闭包和释放责任。

明确的两项身份修复：
- MCP：捕获当轮 Tool/execute 及正确 this，调用前复核 source/tool/server 是否仍启用；旧 Context 不能重新查询后来替换的工具缓存，也不自动重试未知副作用。
- Host：捕获开始固定 topicId；迟到压缩调用时若当前 topic 已切换，先拒绝 E_SOURCE_UNAVAILABLE，业务服务零进入且不通知；不新增 ABA generation/epoch 体系。

**四项最新已获授权的范围调整，别重复申请：**
1. 用户取消 D3 历史消息迁移（不是延后）。不统一 result/output、assistant JSON string 的历史生产/读取格式，不删原有 Driver 兼容转换，也不因此改数据库；保留历史恢复和直接受影响的回归。
2. host/src/im/types.ts：只删除 IMDrivenSourceLike.getMessages 必填声明，不给窄管理接口补 getContext。
3. host/test/session-manager-v3.compaction.integration.test.ts：两个已有 Host fixture 各补 notifyNewMessage 模拟函数，原断言保持；属于基线 fixture 修复，不是身份修复有效先红。
4. host/src/mcp/index.ts：复用现有 Driver 导出的 Tool/jsonSchema，普通对象保持 type:'dynamic'；schema、description、execute、client.callTool、timeout 等全都不改，不加类型强转、不升级依赖；证据在 batch-09/sdk-boundary-proof.json。

以上修改已纳入任务书和 review-evidence/minimal-core-batch-09/scope-revision-01 至 04。任务书白名单仍是上限，不得顺手修改 Runtime 参数校验、SDK Tool/Ref、View 元数据、Observation adoption、历史消息存储、全仓依赖或发布流程。

目前执行证据包括 baseline.json、candidate-declarations、host-final-regression、host-strict-with-tests-final、factory-equivalence、包消费等；早期失败和基线已单列。它们是开发侧证据，不是独立批准。历史文件丢失清单也可能随并行工作继续变化。

### Batch 09 现在该如何推进

1. 立即核对任务书及 scope-revision 的指纹、所有授权生产/测试文件实际 diff、当前 HEAD/index、开发者提交的 REPORT/patch/final-delivery 是否已出现。
2. 若未交付：保留执行者正在工作的代码和测试，要求按任务书收尾；不能和它同时覆盖同一生产文件。异常失败先归因，不用增加 skip、mock 或降低严格度掩盖。
3. 若已 READY_FOR_REVIEW：审查相对**开工实际脏工作树**的独立 patch；核实所有白名单、允许差异和历史保护；独立重跑 Driver、Host、Runtime 受影响门禁，MCP/Host 身份、IM 续轮、包消费和声明。不能把执行侧统计当成亲自运行。
4. 若仍有必要的白名单外改动或证据丢失：最小反例 + 调用路径 + 文件 preimage + 测试影响报上级批准，不扩大“顺便改”的范围。
5. 独立复核通过并保存批准 patch 指纹才能记 APPROVED。否则 CHANGES_REQUESTED 与局部修复。写代码与独立审核不能同一身份自批。

## 4. 接任技术负责人的权责

你是日常负责人，不只是写规划和建议的人：负责组织 Codex/其他执行 Agent、定义可交付批次、审查实际 patch、核验测试与证据、及时给阻断处置，并且每批结束**同步下发下一批**，不等项目所有者反复询问。

| 身份 | 责任 | 权限边界 |
| --- | --- | --- |
| Codex / 执行 Agent | 保存当期开工基线、实现白名单、实际测试、独立 patch + REPORT + evidence | 只能报 READY_FOR_REVIEW，不能自己判 APPROVED |
| 接任技术负责人 | 与执行者身份分离，独立审查、运行必要门禁、给 APPROVED/CHANGES_REQUESTED，主动安排下一批 | 批准限于已授权范围的代码质量；如果自己写了补丁，须由另一个独立审查者复核，或提交上级 |
| 上级负责人、项目所有者 | 产品目标与语义、重大破坏式合同、超范围授权、最终对外发布和 Semantic 验收 | 重大选择必须给出事实与二选一建议，不能被执行 Agent 代签 |

对已有清楚约束的常规局部实现，自己作决定并推动，不反复征询；对新增生产白名单、行为可见差异、证据不可追溯、无法保持真实保护、对外发布，要升级且附可复现最小证据。不要承诺异步自动完成，除非真的具备对应执行机制。

## 5. 质量基线及 minimalist 审核清单

任何所谓“简化”都必须回答：究竟少了哪个重复 owner/字段/分支？其保留责任落在谁身上？什么回归证明核心行为等价？拒绝只追求净删行数，也拒绝新增无消费者的工具框架、缓存、TTL、注册表、通用策略或新配置。

必须保护：
- View/Tool/Ref 同源、正确的 ViewType 动态激活、旧 App/Tool/Ref 来源失效和真实授权；业务文件身份仍归应用。
- 参数捕获、Schema、跨 Worker/IPС 边界必要的校验、容量和预算，不用一个边界的检查替代所有边界。
- 同 invocationId 的同步占位、并发去重、冲突、防重执行、按次结果读取授权；结果过期与关闭真实结算责任。
- 已执行、拒绝、失败、partial/unknown、投影失败、资源是否真的释放的事实区别；未知写入不自动重试。
- Driver 唯一副作用执行者、串行工具执行、stop/disable 逐次门禁、本轮 Context 保持和 finally release。
- Host/IM 历史加载 Promise、追加消息保留、compaction、pending 防多轮、工具结果后的连续性、真实用户消息不可任意更写。
- Preact 只是默认 Adapter；SDK/Runtime 不替 IDE 处理磁盘版本、LSP、业务权限与外部事务。

**测试方法：**缺陷修复需要可证明原缺陷的有效先红；等价删除先做基线刻画后做完整前后对比。通过的必须是当前源码/重建产物/真实解析的包，不能 mock 掉风险链路、复用旧 dist；不得 skip、as any、降低 tsconfig、删除重要断言、以依赖失败充作先红。测试矩阵先围绕受影响风险，再做必要的跨层回归；不建立大而无用的测试平台。

**工作树纪律：**仓库有大量未提交修改与未跟踪产物。HEAD 不是实际基线。每批保存真实 preimage、HEAD/index、相关依赖解析；独立 patch 相对当期开工状态，隔离正反重放。无授权不 reset/clean/stash/checkout，也不擅自恢复、删除历史报告或并行工作。提交、push、merge、发布均须显式授权。后补证据标明“重建”，不能称作当日原件。

状态统一：AUTHORIZED_FOR_IMPLEMENTATION → IN_PROGRESS → READY_FOR_REVIEW → APPROVED 或 CHANGES_REQUESTED；真实阻断用 BLOCKED。APPROVED 只是匹配 patch 的代码复核，不等于所有者 SEMANTIC_ACCEPTED 或 RELEASE。

## 6. Batch 09 之后的路线

先完整收口 Batch 09。后续重点是 SDK 作者体验及 Ref 参数统一，而不是无限寻找两行死代码：

- R4 Runtime 最终参数校验归属与 Raw/Effective Input 的边界，必须单独证明纯 Core trusted factory 的行为不会意外变化。
- SDK：原 MINIMAL 的 U6 主张取消 ToolUI 回传，用普通 View 内容保留操作说明；SRT-01 草案又主张 ToolSet/AppTools/ToolRef/ToolCatalog。两者存在明显“概念越减越多”的冲突，**不能叠加实施**。先比较最小 API 与已存在消费方，再把真正不能用更少概念处理的差异交上级决定。
- Ref/ArrayRef 是 Tool 参数，不再保留第二种工具类别的目标方向；SRT-02/Ref 公共类型、Snapshot 原值、发布 owner、版本、Worker 协议、真实 App 同步迁移必须有可编译合同和对应回归，不能先删旧 Hook 再留下无法运行的消费者。
- 显式 ViewType、Observation 采用新快照等属于需分别冻结的进一步产品语义，**本轮没有自动授权**。用户**已取消 D3 历史消息迁移**，不得换名重新派单。
- 最终组合只在发布候选一致后做：真实 build、tarball、Host、IDE、模型/Agent 作者任务，必要时所有者亲自验收。历史已验收版本不能替代新版本验收。

按阶段做一件完整的事情；可以合并真正有一个风险边界的相关小项，减少无意义的批次交接和证据套娃。但若多个模块共享同一源码文件，只安排一个执行 owner 合并，避免两个 Agent 同时编辑同一工作树。

## 7. 每轮的负责人交付形态

每轮结束时必须同时给出：本批是否准出（批准 patch 指纹）；代码审查实际发现；独立重跑了什么/什么没跑；基线与新增失败如何区分；下一批价值、文件白名单、准出和可转发给 Codex 的 Prompt。若产品层有必须升级的二选一决策，就附对照证据；否则主动继续。

向上级报告尽量短：当前状态、已经确认的事实、风险/阻断、下一步、需要唯一上级决定的事项。不要以测试数量、文件计数和笼统“已全绿”替代执行证据。维持工作节奏、减少用户追问；不能虚构后台工作或预计完成时间的承诺。

## 8. 首次接任的阅读顺序

1. AGENTS.md 和 .agents/skills/minimalist/SKILL.md。
2. MINIMAL_CORE_BATCH_09_TASK.zh-CN.md、scope-revision-01/02/03/04、baseline.json、最近的 candidate 日志；核对 REPORT/patch 是否出现。
3. agent-driver-v2/src/core/interfaces.ts、agent-driver-v2/src/core/agent-driver-v2.ts、runtime/src/adapters/semantic-aotui-driven-source.ts、host/src/adapters/host-driven-source.ts、host/src/mcp/source.ts、host/src/mcp/index.ts、host/src/im/im-driven-source.ts、host/src/im/types.ts。
4. MINIMAL_CORE_REFACTOR_PLAN.zh-CN.md、MINIMAL_CORE_PROGRESS_2026-11-05.zh-CN.md。只提取仍有效的工作，不按旧估算自动派历史消息迁移。
5. deepseek_review.md 的最新确认与 SRT-01_SINGLE_DECLARATION_PLAN.zh-CN.md；后者是拟议作者方案，不是必须实施的 API。

接任首报必须回答：Batch 09 到底处于 IN_PROGRESS、READY_FOR_REVIEW 还是 BLOCKED？哪些门禁实际有当前构建证据？其 patch 是否与授权白名单一致？历史证据路径缺失对验收和治理意味着什么？哪些事实需要上级裁决？之后立即推进本批，而非只交一份抽象计划。
