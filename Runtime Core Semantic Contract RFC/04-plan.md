# RCSC-04 — 开发计划、依赖关系与里程碑准出

- **状态**：Draft / 不表示工程任务已经执行
- **依据**：[00 目标与约束](./00-charter.md)、[01 可行性](./01-feasibility.md)、[02 影响面](./02-impact.md)、[03 技术方案](./03-design.md)、[05 测试计划](./05-tests.md)
- **范围**：方案 C 之 Snapshot Contract；不扩展为全面 Runtime/SDK 改写
- **计划原则**：先证明，再冻结协议；先 shadow 后 strict；先内聚语义再考虑拆包；每个阶段有可运行证据与回滚条件

## 1. 发布模型与组织方式

每个里程碑拆成可独立 Review 的小 PR/变更集。阶段末不以“代码写完”为完成，而以测试报告、风险清单、可回滚版本、文档交叉一致性为准出依据。

- **M0 基线与可行性门槛**：先研究现有代码与 Preact Hook 时序，决定是否 Go。
- **M1 纯 Core 契约和 Store**：不依赖 Worker/DOM；无用户可见行为变化。
- **M2 Worker Producer / IPC shadow**：运行新旧两套快照生产，但仅旧路径对外执行；新路径绝无副作用执行。
- **M3 SDK 注册/捕获屏障与严格校验**：完成一致性技术前提；修复 Ghost Ref 与 Tool 时序。
- **M4 读取/来源绑定与 Tool 执行切换**：在可控开关下使用新 Snapshot 进行读取和执行。
- **M5 IDE 回归、灰度、废弃兼容逻辑**：证明稳定性，准备正式使用。
- **M6 后续可选优化**：性能预算收敛、增量 Producer、接口拆包（不作为 M5 前提）。

### 1.1 依赖图

~~~text
M0 Spikes & Baseline
        |
        v
M1 Core Contracts/Committer/Store
        |
        v
M2 Producer + Versioned IPC (shadow)
        |
        +--------------+
        |              |
        v              |
M3 SDK Barrier         |  (旧适配在 shadow 中保持可运行)
        |              |
        +-------+------+
                |
                v
M4 Strict Read + Bound Tool Execution
                |
                v
M5 IDE Regression + Controlled Rollout
                |
                v
M6 Optional Performance/Extraction
~~~

严格约束：M4 依赖 M3 的原子屏障证明、M2 的版本化 IPC 与 M1 的 Core Store；不能用“测试大致通过”绕过任何一项。

## 2. M0：代码审计、基线与可行性闸门

**前置**：RFC 00/01/02/03 Draft 与本地工作树可读取。**不改现有业务源码**。

### 任务
- M0-T1：记录当前 App/Worker/SDK API 真正导出的接口和调用链；冻结当次审计的 Git 状态及相关源码哈希/文件清单（保留已有未提交更改，不清理）。
- M0-T2：执行 SP-01/02：极端 View 挂卸载、useDataRef/useArrayRef/useViewTypeTool enabled 切换、同一 tick/microtask 变更，记录 DOM 和 Registry 真实先后。
- M0-T3：执行 SP-03：扫描典型应用 Ref payload，检测 Object/Date/Map/class/循环引用、尺寸分布，确定默认 Codec 策略。
- M0-T4：执行 SP-04/05：WorkerPool 重用/重启旧消息与 View ID 复用，复现可产生错绑定的最小用例。
- M0-T5：执行 SP-06/07：Workspace snapshot 现状、View 数量/文本量/Ref 数量/提交或读取耗时内存基线。
- M0-T6：列出正式 Runtime 与实验代码的可复用最小技术片段，说明没有迁入 Action/Observation API。
- M0-T7：明确安全兼容开关（legacy/shadow/strict）、可接受的历史保留预算与第一版性能回归阈值；阈值以实测基线确定，不凭空写数字。

### 交付
- Code audit evidence（源码路径/方法/现状表）、Spike 执行记录、失败用例/可复现 fixture、性能基线、遗留行为差异表。
- RFC 03 中开放问题 Q-01～Q-05 的实测答复及需更新的决策条目。

### 准出门槛
- SP-01/02 明确找到可实现的 flush-ready 方案或给出必须调整 SDK 内部注册机制的有限改造清单；
- SP-03 有数据兼容清单，不能静默允许不可序列化 Ref；
- 错 Ref、重启旧包、Ghost Ref 场景可复现且已定义期待结果；
- 无任何既有业务修改被丢失；输出 Go / Conditional-Go / No-Go。
- **No-Go**：无法可靠判定一轮 View/Ref/Tool 准备完成，且没有可行的 SDK 内部修正手段。应回到 RFC 重新设计，而非弱化 INV-01。

## 3. M1：建立纯 Runtime Core Snapshot 契约

**依赖**：M0 完成 Go/Conditional-Go；00 中 INV 与 03 中数据协议已获设计评审。

### 建议 PR 切分
- **M1-A / Types**：新增 AppSnapshot、PreparedDraft、ViewSnapshot、RefDescriptor、ToolDescriptor、WorkspaceSnapshot 和 health、errors；只暴露内部 API，勿立刻发新 npm 包。
- **M1-B / Copy+Validate**：JSON-safe defensive copy，拒绝访问器/循环/非 Plain Object、超限；SchemaVersion、View ID、Ref scoped key、Tool ID/Schema 校验器。复用实验思路，保留 Tool 术语。
- **M1-C / Committer**：按 instanceId + producerSeq 来源校验；内容指纹、成功 revision、同内容复用、失败不更新 pointer；将 Core 内部写入口与公开 Reader 分离。
- **M1-D / Store**：current 持有、retained history、lease、TTL、容量上限、unready/ready/degraded/stopped、structured errors。
- **M1-E / Memory Fixtures**：最小无 DOM App Producer：View + Ref + ViewTypeTool + ToolResult，覆盖成功/过期/失败/状态变化。

### 准出
- T-01、T-02、T-05、T-09、T-10、T-14、T-16 中不需要 Worker 的部分通过；
- 不需要 HTMLElement、Preact、Worker Threads 即能完整编译和运行核心契约单测；
- 同源内容相同的重复读 ID 不变；App 重新实例化 ID 不会重用；失败不推进 revision；
- Store 不会被调用方更改、lease release 不会删除仍被 Store 持有的 current；
- 旧正式 App/SDK 测试无行为回归（至少可执行的现有测试集）。

## 4. M2：Worker SnapshotProducer 与协议 Shadow

**依赖**：M1；M0 完成 SP-01/02 时序调查，不要求 M3 SDK 修复提前完成。

### 建议 PR 切分
- **M2-A / Worker identity**：运行时在 App 新实例启动时分配 instanceId；重置、Pool 复用、IPC 全链透传。
- **M2-B / IPC**：新增 SNAPSHOT_PREPARED / SNAPSHOT_PREPARE_FAILED，schemaVersion、producerSeq、sourceEpoch；旧 SNAPSHOT_FRAGMENT 保留在 legacy 下；禁止 timestamp 作顺序权威。
- **M2-C / ProducerAdapter**：复用现有 DOM Transformer/View extractor + AppKernel Ref/Tool 导出，生成 Draft，先 shadow 探测不变量。
- **M2-D / Host Receive**：WorkerHost 识别来源实例及序号，在主 Runtime 调用 Committer；严格区分 sender 接收成功与 commit 发布成功。
- **M2-E / Shadow Diff**：在运行时产生旧/新 View、Ref、Tool 对照日志（默认脱敏/大小受限），新路径不驱动任何 Tool 执行。

### 准出
- T-02、T-03、T-04 的生产端探针、T-09、T-16 通过；
- 同毫秒多次有效变更可区分；旧实例/乱序消息不得覆盖 current；
- 旧 IDE 仍走 legacy，无强制 SDK API 变更；shadow 差异有分类报告；
- 无跨模式复用 Snapshot ID，无 shadow 模式下的副作用双执行。
- **阻塞**：无法隔离旧 Worker 消息或发生跨实例数据串线。

## 5. M3：SDK ProjectionBarrier 与结构化索引

**依赖**：M2 shadow 能运行；M0/SP-01/02 确认改造路径。

### 建议 PR 切分
- **M3-A / Coordinator**：View/Ref/ViewTypeTool 的 dirty epoch、commit-ready、挂卸载生命周期；不允许未提交 render 副作用污染已发布视图。
- **M3-B / Hook internals**：在保持 useDataRef、useArrayRef、useViewTypeTool 外部 API 的前提下，改造内部注册/卸载原子性，Refs 改变即使 DOM 不变也会 invalidation。
- **M3-C / View identity**：View generation token，动态列表删改/重开同 ID 不能复活旧绑定。
- **M3-D / Ref + Tool typed descriptor**：将混合 IndexMap 拆为 refs/tools，Root 注册与目标 ViewType 区分，定义 known Ref marker 的最低验证能力。
- **M3-E / SDK error DX**：Ref 非 JSON/缺失 Codec、Tool schema 失效、重复 ID 等给出定位到 App/View/Ref/Tool 的错误。
- **M3-F / Reconcile**：修正 current legacy registry 导出与 snapshot shadow 输出之间的差异；严禁为性能跳过正确性校验。

### 准出
- T-04、T-05、T-07、T-14、T-15、T-16 通过；
- 100% 已知的 SDK Ref 标记在发布版本中能被按作用域解析，不能出现 Ghost Ref；不将普通 Markdown 链接错误认定为 Ref；
- useEffect/useLayoutEffect 快速交替及异步状态更新只发布 coherent Draft；
- Preact SDK 外部调用方式保持，Tool 定义和业务 Handler 正常工作；没有无解释的非 JSON 对象自动降级；
- 无法取得一致 Draft 时发布失败且 health=degraded，不输出假成功。

## 6. M4：Strict 读取与来源快照绑定 Tool 执行

**依赖**：M3 全部准出；M1 Store、M2 IPC 已验证。

### 建议 PR 切分
- **M4-A / API**：readLatest/getById/acquire 明确最新与历史 lease；旧 acquireSnapshot 包装新 Reader，但没有新的读取即创建 revision。
- **M4-B / Workspace**：组合已有 AppSnapshot vector，区分 degraded/unready；保留旧 Markup/IndexMap 的单向派生兼容层。
- **M4-C / Ref resolver**：只从来源 Snapshot + View generation + scoped Ref 解析；不再全局尾部搜索/字符串碰运气。
- **M4-D / Tool binding**：来源快照 ToolDescriptor + 输入 Schema 验证 + 当前 Handler/权限/业务条件再检查；默认 mutating 时版本冲突保守拒绝。
- **M4-E / Result semantics**：保持 Tool Handler 原始 success/failure，不把失败包装成功；无法确认副作用时返回 unknown 类错误、不自动盲重试。
- **M4-F / End-to-end flags**：在单一 App 实例/会话边界启用 strict；legacy/shadow 仍可回退但不能混用 Ref ID、不能双执行。

### 准出
- T-01～T-12 中适用的全部通过，尤其 T-06（错绑定/TOCTOU）、T-07（Tool 变化）、T-08（结果）、T-10（lease/expiry）、T-11（隔离/回退）；
- 恶意或过期 Ref 无法指向另一个 View/新文件；旧实例 Tool 不会作用于新实例；
- strict 模式发生验证失败时不得 fallback 旧活态 Registry 继续执行写入；
- SnapshotStore 与外部消费端在读取/执行路径中一致使用来源 Snapshot ID；无模式串线。

## 7. M5：IDE 验收与受控推广

**依赖**：M4 严格路径通过；M0 性能/兼容基线存在。

### 建议 PR 切分
- **M5-A / E2E Harness**：基于真实 IDE 文件树、FileDetail、SearchResult、LSP mock/real optional，自动化用户路径。
- **M5-B / Stability**：Worker 重启、连续打开/删除/重排 View、多工具快速调用、业务异常、健康态退化/恢复。
- **M5-C / Telemetry**：快照尺寸、准备/校验/提交耗时、drop/retry/degraded、lease bytes、Ref/Tool 校验错误计数。
- **M5-D / Rollout**：先测试 App，再 IDE 灰度；每阶段检查错误率、快照一致性和性能预算。
- **M5-E / Cleanup Gate**：仅在 strict 稳定且所有外部读取/执行调用方迁移后移除过时分支；保持可控兼容窗口，不永久双轨。

### 准出
- T-12、T-13 完整通过；新旧 IDE 用户可见主要行为等价，错误路径更加明确；
- 边界场景无错误 Ref 绑定、Tool 重复执行和版本倒退；
- 性能回归满足 **M0 实测后批准**的时延/内存预算，或存在有证据的可接受例外与后续任务；
- 有明确回退开关、诊断手册和责任人；生产推广需要单独 Review/批准，不由本 RFC 自动执行；
- 旧行为删除前通过兼容性消费者搜索、对应 tests 和静态依赖审查。

## 8. M6：可选的后续优化（不阻塞 M5）

- 从 DOM Producer 迁到可直接构建语义 View AST 的其他 Producer；
- 增量 View 提交、去重/缓存优化；多 App 大规模观察压测；
- Runtime Core 与 Adapter 逻辑分包（此前应先证明 pure core 宿主无关）；
- 更细粒度 entity-CAS、Tool 签名稳定性/业务错误诊断增强；
- 不突破 INV-01～12，所有优化需跑相同 Contract Test Suite。

### M6 准出
- T-01～T-16 中与受影响路径对应的测试全部回归，必要时增加新的 Producer/Adapter 专项测试；
- 与 M0/M5 可复现实测基线比较，性能或可替换性确有证据；无新增错误 Ref/Tool/版本回归；
- 新 Producer 与现有 Producer 通过同一 Core Contract Suite，不能创建第二套 Snapshot 真相；
- 若改为新的发布包结构，先确认源码依赖边界、兼容窗口和文档对齐，再批准发布。

## 9. 跨阶段硬性 Definition of Done

每个变更集必须具备：
1. 明确的归属代码路径、公开/内部边界，和为什么该变更属于本阶段；
2. 相关测试的执行命令、退出码与原始日志归档位置（没有执行必须记 Not Run）；
3. 新/旧行为差异、错误码和兼容策略；有向后兼容破坏时给迁移路径；
4. 对应 00 的 INV、03 的 D-xx、05 的 T-xx 的可追踪映射；
5. 对旧用户代码零非预期强制迁移，风险和回滚方式清晰；
6. 未破坏原工作树的其他未提交修改、不清理不重置其他工作项。

**推荐检验命令（将在实际实现阶段确定执行环境）**：runtime/package.json 的 test:run/build、sdk/package.json 的 test:run/build，以及 IDE app 自身测试与真实集成 Harness。命令可运行性需在本地核实，不把“计划命令”当成测试通过。

## 10. 里程碑依赖与责任矩阵

| 阶段 | 必须输入 | 主要输出 | 主要验证 | Blocker/No-Go |
| --- | --- | --- | --- | --- |
| M0 | 当前代码、RFC 初稿 | Spikes、基线、风险决议 | SP-01～07 | 缺少可实施的就绪屏障 |
| M1 | M0 + Contract Review | Core Types / Validator / Store | T-01/02/10/14/16 | Core 仍需 DOM |
| M2 | M1 + 旧协议梳理 | Producer shadow、version IPC | T-02/03/09/16 | 旧消息可覆盖新实例 |
| M3 | M2 + SP-01/02 | SDK Barrier、Ref/Tool 语义索引 | T-04/05/07/15 | Ghost Ref/Tool 仍可出现 |
| M4 | M3 + Store/IPC 完成 | strict read/execute、compat facade | T-06/07/08/10/11 | 错绑、失败吞没、跨模式串线 |
| M5 | M4 + baseline | IDE E2E、灰度、清理决议 | T-12/13 全回归 | 影响主要业务或超出批准预算 |
| M6 | M5 | 可选优化与物理分层 | 合同回归 + 性能 | 破坏既有 INV |

**关键路径**：M0 → M1 → M2 → M3 → M4 → M5。M6 非必经。需要多方协作时可并行准备测试 Fixture/Benchmark，但各阶段发布顺序不得因并行而跳过 Gate。

## 11. 项目范围控制与变更管理

- 新需求先说明是否解决 Snapshot 不变量或阻断 Gate；否则登记后续 RFC，不挤入本期。
- 凡改变 AppSnapshot identity/revision、Ref/Tool 寻址或跨 App 一致性定义的设计变更，必须同步更新 00、03、05 和 06。
- 若 SDK 公共 API 必须修改，必须单独评审影响、示例更新、兼容窗口与迁移脚本，不可在 M3 顺手破坏。
- **终止策略**：任意里程碑发现原子屏障无法保证或错 Ref 操作无法防止，应停留 legacy/shadow，回到设计；不以牺牲核心语义换进度。

**计划总结**：以 M0 的真实 Spike 降低最大不确定性，以 M1/M2 建立无 DOM 的 Core 和并行 shadow，以 M3 兑现 SDK 提交屏障，以 M4 切换 strict 执行，以 M5 用 IDE 真实路径证明可行。

## 12. M0 第一轮执行后的阶段状态与依赖微调（2026-10-21）

真实执行详情见 [m0/RESULTS.md](./m0/RESULTS.md)。

- **当前状态**：M0 First Pass Executed，Conditional-Go for **M1 Pure Core only**；M0 尚未完全关闭。
- **已满足的部分**：SP-01 真实 SDK 时序反证；SP-02 commit-phase 微型 PoC；SP-03 TS AST Ref 清单及非 JSON 边界样本；SP-04 真实 Worker IPC 接收器的同毫秒/不匹配 appId 问题；SP-05 源快照与活态 Ref 错绑；SP-06 旧 Workspace 无 vector；SP-07 合成投影微基线。现有 SDK/Runtime/IDE 单测已跑并有日志。
- **允许启动的任务**：M1-A/B/C/D/E 的**纯 Core 代码与合同测试**，必须与现有 SDK/IDE 路径隔离，不开启 strict，不为当前有损数据静默 fallback。
- **不允许启动的任务**：在 M3 Barrier 严格准出前接管正式 IDE Tool 执行；在 M2 源端身份检查前把新 Prepared Draft 当权威最新状态；在未审查 Ref payload 前放宽序列化拒绝规则。

### M0 剩余跟进（不阻断纯 Core M1，但阻断相关后续 Gate）

| 跟进 ID | 内容 | 必须完成时点 |
| --- | --- | --- |
| M0-R1 | 正式 WorkerPool 重建/重用后旧 IPC 晚到及真实实例代际故障实验 | M2-A/B/D 准出前 |
| M0-R2 | 代表性真实 App 的运行时 Ref payload 兼容性/大小分布采样，不只依赖 TS 类型 | M3 strict SDK 迁移决策前 |
| M0-R3 | 实测 Preact/Worker IPC/大文件/多 View 工作集的端到端延迟与峰值内存预算 | M5 性能推广前 |
| M0-R4 | 在声明 Node >=24.22.0 的环境下复核实验测试（当前 Node 23 执行通过但有 engine warning） | 引入实验算法到正式 Core 之前 |
| M0-R5 | 决定 useArrayRef listRef 的严格 Ref 语义和旧调用方兼容方式 | M3-D/E 准出前 |

### 更新后的 M1 准入约束

M1 只处理纯 Snapshot Contract 的类型、拷贝、校验、Committer/Store、不变量测试，不能假定 Producer flush-ready 已存在。Memory Producer 提交的 Draft 应显式构造完整一致的 View/Ref/Tool；之后真实 DOM Producer 必须通过 M2/M3 提供同等保证。

**任何一次 M1 PR 都要关联 05 的 INV→T 追踪矩阵，不因本次 baseline tests 全绿便声称新契约正确。**

## 13. M1 实施及准出登记（2026-10-22）

**状态：M1 isolated gate = PASS；M2 尚未开始，Strict No-Go。** 真实执行日志、代码、覆盖率及剩余风险请见 [M1 实施报告](./m1/RESULTS.md)。

- M1-A 完成：在 runtime/src/core/snapshot/ 新增内部 App/View/Ref/Tool、AppSnapshot/WorkspaceSnapshot 数据协议和身份类型。
- M1-B 完成：独立数据复制、严格校验、最大深度/条目/字节等预算；对非 JSON 数据不静默兼容。
- M1-C 完成：唯一 Committer、instanceId/producerSeq/sourceEpoch、成功 revision、同内容复用、失败不部分发布，并支持可信来源 PREPARE_FAILED 报告。
- M1-D 完成：Current/History Store、Lease、TTL、容量、App 生命周期代际、按来源快照精确 Ref/Tool 只读查询。
- M1-E 完成：无需 DOM/Worker/Preact 的内存任务 App 与 WorkspaceSnapshot 版本向量组合；不替代未来 M4 的 ToolHandler 执行授权。

实际测试（详见报告）：新 Core 52 tests passed，覆盖率 Statements 95.95%、Branches 87.06%、Functions 100%；Runtime 完整 432 passed/3 skipped/7 todo，SDK 64 passed，IDE Jest 5 passed，Runtime noEmit 退出码 0。

**M1 边界**：没有改动既有 SDK/Runtime 执行链，没有变更对外包导出。M1 合同测试证明纯 Core 可以接收完整 Draft 并正确提交，不证明现有 DOM Producer 的异步捕获同源一致性。M2 必须把可信 Worker 来源与准备协议接入 shadow；M3 必须证明 Hook 生命周期屏障；M4 才能启用 strict Tool 执行。

**下一阶段依赖**：优先 M2-A（可信 App instance）、M2-B（版本化 IPC）、M2-C（旧 DOM Producer 适配的无副作用 shadow），后续 M2-D/E；不得跳过旧 Worker 晚到测试、Codec/Marker 差异统计、出错 lastGood 的 health 传播。

## 14. M2 Shadow 纵向切片阶段状态（2026-10-22）

**状态：M2-A / M2-B / M2-C / M2-D = 已编码并完成测试；M2-E = 计数级诊断已编码，完整语义 Diff 未准出。Strict 仍 No-Go。**

[M2 实测报告](./m2/RESULTS.md) 已包含真实 Worker Runtime + 临时 App Factory 的 E2E、同一物理 Worker RESET/复用、来源伪造拒绝、旧同毫秒丢帧对照、SDK/Runtime/IDE 全套测试。

- M2-A：逻辑 App 代际与 Worker reset 身份已测试。遗留消息能否绕过旧 Fragment 路径是现存风险，尚未按严格来源协议统一修补 legacy。
- M2-B：新增 Shadow IPC，producerSeq/sourceEpoch 和 instanceId 可检验，且不改变 legacy Fragment 的消费形状；sourceEpoch 仍只是过渡性捕获世代。
- M2-C：首个 DOM Producer 可将旧 View/Ref/ViewTypeTool 投影到 M1 AppSnapshot Draft；Typed Ref 和准确 Tool Schema / owner token 必须依靠后续 SDK 补齐。
- M2-D：Shadow Receiver 按绑定实例接收、将合法 Draft 交给 Core；错误只影响 Shadow 状态，不替代原有 Tool 执行。
- M2-E：已按旧新同一次捕获的序号配对并输出数量 delta/unpaired 计数；尚需细粒度内容/引用/Schema 差异报告和真实 IDE 高压力数据才能完全准出。

**下一阶段优先顺序**：M3-A ProjectionCoordinator → M3-B SDK Ref/Tool-only invalidation → M3-C View Generation/owner token → M3-D/E Typed Ref/Tool & Marker 语义；随后继续 M2-E 的准确语义 Diff 与 IDE 综合验证。绝不能直接将当前 Shadow health=ready 当成 Strict 可执行状态。

## 15. M3 本轮实际交付与剩余准出依赖（2026-10-22）

见 [M3 实施记录](./m3/RESULTS.md) 和 [最终回归](./m3/final-regression.log)。

| 阶段 | 本轮完成的工作 | 当前准出 |
| --- | --- | --- |
| M3-A / Coordinator | 纯 TS epoch、nested begin/end、合并通知、签名 Token；无 Host/DOM 依赖 | **核心实现与测试通过** |
| M3-B / Hooks & semantic events | View/Ref/Tool 同步 Layout 注册、Ref-only/Tool-only mutation 推进 epoch、默认 legacy 和 Shadow 均有真实 Worker 验证 | **常规路径通过，完整异步/异常屏障仍待测** |
| M3-C / View generation | SDK View 每次挂载有 generation，DOM Producer 和 Ref/Tool origin 继承它；旧挂载 owner 不复活 | **主要路径通过** |
| M3-D / Typed Ref、Tool 描述 | typed list/item Ref Marker 与注册表一致；bare alias 保兼容；Tool declaration owner 与 target ViewType 分离 | **合同切片通过，Codec/Schema/parity/内存预算待验证** |
| M3-E / SDK 错误 DX、兼容 | 基础错误仍可诊断，当前没有实现完整 Codec、Typed collection locator 或新的大型 SDK 声明接口 | **尚未准出** |
| M3-F / Reconcile | 普通状态与实际 Worker Ref A/B 历史 Source 测试通过，但还没有真实 IDE 大工作集全量 Shadow Diff | **尚未准出** |

### 后续严格准出的阻塞顺序

1. **M3-G1**：异常渲染、异步重入、第三方 Hook、未通知的原地业务变更策略；完善并证明真正的 SDK Snapshot Producer flush-ready 协议。
2. **M3-G2**：正式 Ref Marker 词法/AST 验证器、非 JSON Ref payload 显式 Codec、数组 Ref alias 与大列表内存预算。
3. **M3-G3**：ViewTypeTool Schema 与 SDK defineParams 等价、Tool declaration owner 生命周期、Root → FileDetail 目标映射的完整回归。
4. **M3-G4**：真实 IDE/Planning App 多 View、搜索、LSP 与快速文件变更的 Shadow 原子一致性及性能基线。
5. **M4 执行门槛**：统一旧 Ref Resolution，按来源 Snapshot/Ref/Tool 绑定执行，修复 ToolResult 业务失败包装成功，执行时做业务权限/版本检验。

**不允许跳跃**：不能因 M3 的 SDK 72 tests 与 Runtime 452 tests 通过，就将 Shadow 自动切换为 Strict，或对外宣布原始 P0 全部解决。

**本次增量测试**：Runtime 452 passed（3 skipped/7 todo），SDK 72 passed，IDE Jest 5 passed，Runtime/SDK TypeScript exit 0。所有行为来源于本地实际测试，不是预计指标。
## 16. M4 前置 Stage 0：已验证的最小 View-owned Tool 合同

[M4 前置执行证据](./m4-preflight/RESULTS.md) 与 [方案 B](./07-view-owned-tool-identity-proposal.md)。

- **Stage 0 PASS**：只新增 runtime/src/core/tool/view-owned-tools.ts 与测试，复用现有 SPI OperationResult、M1 copyJson/canonicalJson 和原生 Map；没有扩充 SDK API 或 npm 包。19 个纯 Core 测试通过，聚合、独立可用性、旧实例失效、业务失败传播均确定。
- Runtime 全套 471 passed、3 skipped、7 todo；SDK 72 passed；IDE Jest 5 passed；Runtime/SDK 类型检查退出码均为 0。
- **Stage 1 待实施**：Runtime 分配真正的 ViewInstanceId，并在 SDK <View> 生命周期中安全挂载/注销；View-local useViewTypeTool 在兼容旧参数 API 的条件下注册；新旧 Registry 可观察 Shadow 并证明不会互相覆盖/误删。
- **Stage 2 待实施**：将绑定版号/来源实例写入有版本的 Snapshot 契约，从 pinned Runtime Core Store 解析来源；正式 Tool Router 按实例调度并复核权限/业务 CAS，修复外层 ToolResult 错误包装，最后通过 IDE E2E。
- 保留此前 M3 异常/异步 Capture、非 JSON Codec/Marker、真实 IDE 负载准出限制，不应以本阶段纯 Core 测试通过替代。

**正式 M4/Strict NO-GO**。不得在无 Snapshot 验证的情况下直接将 Agent 的 tool/viewInstanceId 参数作为执行授权。


## 17. M4 Stage 1/2 实施后 Gate（2026-10-22）

[Stage 1](./m4-preflight/STAGE1_RESULTS.md) 与 [Stage 2](./m4-preflight/STAGE2_RESULTS.md) 已有源码和真实回归证据。

- **Stage 1 = PASS**：Runtime 签发 ViewInstanceId、真实 SDK View 内 useViewTypeTool、同类型多实例独立注册/聚合、兼容 Root 旧签名、关闭/重挂载/RESET、冲突回滚；SDK 84 passed、Runtime 472 passed、IDE 5 passed。
- **Stage 2 = PASS（严格限定为只读 V2 Core + Shadow）**：V2 versioned Snapshot Schema/Validator/Store，同源 Tool 目标和 Ref 身份的原子 Commit，V1 继续正常读取与发布；只有 Runtime 已注册且完全 View-owned 的 Shadow App 走 V2。新增 25 Runtime 验证后总 497 passed，SDK 84 passed，IDE 5 passed。
- Stage 2 新的 acquireToolSource 只从 Store 中有 Lease 的已提交 V2 获取来源、检查当前实例/Tool binding 和 Schema；不返回 Handler，也不能成为 Agent 执行授权。
- **Stage 3 待实施**：正式 Worker/Agent Tool 调度与 V2 可信来源贯通、V1 mixed/Root 渐进迁移、实时 Handler/权限/业务 CAS、失败成功语义、App 生命周期竞态的完整 E2E。必须先修正 IDE fd_index 的位置身份问题。
- **性能门槛未准出**：V2 由于加 ToolTargets 和 V1 代理验证有复制成本；真实 IDE 多 View/LSP 工作负载、100/1000 View 拷贝成本、Schema 等价测试和 M3 异常/异步 CommitBarrier 仍需验证。

**Strict 和原始 P0 完全结束仍 NO-GO，禁止直接将 Shadow report 的 ready 当作授权。**


## 18. Stage 4 验收与剩余 P0 路线（2026-10-23）

[M4 Stage 4 报告](./m4/stage4/RESULTS.md)：
- 默认路径修复已经执行：AppWorkerHost 同毫秒消息不丢帧、错误 appId/instanceId 拒绝、明确 shadowCaptureSeq 递增；真实 Worker IPC 与 2 个新增拒绝测试通过。
- SDK/Agent ToolResult 已具备 success:false 透传；本轮进一步拒绝错误的字符串型 success 状态，避免兼容路径包装成成功。
- IDE create_file 不再返回推测 ViewID，原生 wx 排他创建避免并发覆盖，文件已经创建后 UI 失败返回成功和警告。真实 temp 文件的并发创建测试及 IDE 业务回归通过。
- V2 不改变安全边界地省去一次可信代理的重复 copyJson，Stage 4 三次重复 synthetic 100 View p50 约 8.987–9.551ms；完整 Runtime/SDK/IDE 测试全部通过。
- **下一步只允许在真实 IDE 隔离工作区、带业务文件版本 CAS 的受控写入中验证**。先建立读取时的文件/实体版本，再在执行时确保同一 ViewInstance/Tool binding/权限与当前资源版本成立，明确外部并发写入/取消语义。不得直接切换默认 Agent write_file。
- M3 原子 CaptureBarrier、V2 大工作集内存/p95、真正模型/Host 独立执行 Gate 仍未完成；完整 M4/Strict 不准出。


## 19. M4 Stage 5 受控文件前置条件 Gate（2026-10-23）

[M4 Stage 5 实施证据](./m4/stage5/RESULTS.md)：
- Stage 5-A PASS：纯 Core 只从可信 V2 Store/Ref 取得带版本资源，不接受 Agent 自报哈希；7 个来源合同测试。
- Stage 5-B PASS：SDK useEntityRef 及 V2 Producer 正确保留实体身份与版本；Ref-only 版本变化使新 Shadow 失效旧资源来源；真实 Worker/SDK 测试通过。
- Stage 5-C PASS（合作式范围）：IDE 受限版本替换使用内置 fs wx、SHA-256、工作区 root、临时文件 fsync/rename；并发、旧版本、符号链接、硬链接、越界等 11 个实际文件系统负例通过。
- Stage 5-D PASS：5 个 Pure Core+真实 FS 联合测试，另有 1 个真实 Worker/SDK/V2/真实 FS 的来源与写入联合测试；4 轮稳定性复跑均通过。
- 阶段结束全量：Runtime 525 passed /3 skipped/7 todo；SDK 86 passed；IDE Jest 25 passed；Runtime/SDK/IDE TypeScript 均 exit 0。

**未准出**：正式 Agent Mutating Tool 路由、跨业务资源的 CAS/撤销/鉴权、非合作式外部进程的完全 OS CAS、M3 异步捕获屏障、IDE 大工作集/LSP 与真正第二 Host Adapter。不允许以 Stage 5 PASS 打开默认 Agent 文件写入；下一步必须优先做隔离权限和实际文件修改资源冲突完整负例，再通过产品安全评审，方可考虑功能开关。
