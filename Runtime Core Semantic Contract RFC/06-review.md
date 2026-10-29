# RCSC-06 — 分批一致性审查与决策日志

- **性质**：审查日志（Living Document），记录真实检查结果，不把未执行的测试写成通过。
- **基线**：本地工作树 HEAD 789ef07 + 未提交变更，仅以代码为事实源；不读取旧仓库 Markdown。
- **审查顺序**：R1（00/01）→ R2（02/03）→ R3（04/05）→ Final（全局静态校验）。

## R1 — 目标与可行性阶段（2026-10-21）

### 已检查
- 00 与 01 目标一致：Snapshot 是版本化、不可变语义读取契约；Runtime 不拥有业务 Store。
- 术语一致：App / View / Ref / Tool；ViewTypeTool 是 SDK 名称；遗留代码和实验中的 Operation、Action/Observation 仅作代码事实说明。
- 原子性边界一致：单 App 保证强同源一致；Workspace 仅聚合已提交 AppSnapshot、附版本向量。
- 非目标一致：不讨论模型驱动逻辑和 Mobile，不改写现有 SDK 公共调用形态。
- 代码证据由本地 TS/TSX 核查：Worker Fragment、AppKernel registries、SDK Hook 时序、Registry API 以及实验代码；没有读取旧项目 Markdown。

### 发现的问题与处理

| 审查 ID | 问题 | 处理 |
| --- | --- | --- |
| R1-01 | F-02 的“在 Worker 侧校验并交换 pointer”可能被理解为 Worker 对外发布最终快照，和 00 的 Core owns Commit 混淆 | **已解决**：技术设计明确权威 Committer/Store 运行在 Runtime Core 所属进程；当前 Worker 只负责 Prepare/Capture 和 producerSeq，发布 revision 由 Core 提交时生成 |
| R1-02 | 方案 C 只有“同函数收集”不足以证明 Hooks 的生命周期提交屏障 | **已解决为门槛**：SP-01/SP-02、M2/M3 必须提供可证实的 flush-ready / epoch 机制后才能进入 strict |
| R1-03 | 不可变 Ref 若包含函数/循环/非 JSON 对象会影响 SDK 兼容 | **保留待决**：Q-01；先 shadow 统计，默认 strict fail-closed；显式 Codec 是可选迁移方案 |
| R1-04 | 实验代码使用 Action/Observation，语义不同，直接迁入会污染新 API | **已解决**：仅参考数据复制、稳定绑定、版本校验、回执与测试模式；不直接移植执行循环 |
| R1-05 | 00/01 链接指向尚未编写的 03/04/05 | **阶段性预期**：后续文档落盘后统一查断链 |

### 第一批准出

原则性文档与可行性分析已落盘。方案 C 符合非侵入迁移目标，但 commit barrier、不可变 payload 兼容性及当前 SDK 注册时序仍是预研依赖，不能被描述成“已经实现”。

## R2 — 技术方案与影响面阶段（2026-10-21）

### 已检查
- 02 文件路径与本地代码对应（包含 runtime/worker-runtime、AppKernel、SnapshotFormatter、SDK Hook 和 IDE）；影响程度与 03 设计的改动面相符。
- C 方案 Commit Authority 与 00 一致：Worker 为 Producer；主 Runtime 的 Core Committer/Store 为权威发布方，成功 Commit 才有 revision。
- instanceId、producerSeq、sourceEpoch、revision 在 01、02、03 各自有独立含义。
- 03 已区分 AppSnapshot（强同源一致）和 WorkspaceSnapshot（带版本向量的组合观察），未偷偷引入跨 App 事务。
- 03 对现有 ViewTypeTool 在 Root 声明、目标 ViewType 为 FileDetail 的事实作了明确区分；未把声明位置当作执行目标。
- 首批静态检查发现 03 代码块成对闭合、02/03 对 00 的核心术语不冲突；04/05 暂缺为阶段性预期。

### 差异修复

| 审查 ID | 问题 | 处理 |
| --- | --- | --- |
| R2-01 | 01 曾写“WorkerHost 按 revision 判旧消息”，与“Core 才分配 revision”冲突 | **已修复 01**：WorkerHost 校验 instanceId/producerSeq，成功 Core Commit 才有 revision |
| R2-02 | AppSnapshot refs 使用 Record，若直接拿裸 refId 作 key 会跨 View 碰撞 | **已修复 03**：明确编码 ownerViewId + ownerViewGeneration + refId 复合键 |
| R2-03 | View id 关闭后重开会产生 ABA，同 app instance/revision 仍不足以证明 View owner | **已修复 03**：ViewSnapshot.generation、Ref.ownerViewGeneration、Tool declaredByViewGeneration |
| R2-04 | 03 最初对 SnapshotStore 暴露 commitPrepared，和 Committer 唯一发布权有冲突 | **已修复 03**：对一般读者只公开读取/健康管理；Committer 独占写指针能力 |
| R2-05 | 协议显示 Ref marker 的 lexical 校验受旧 SDK Markdown string 限制 | **诚实标注**：03 D-05 仅承诺已知的显式 Marker 校验；M0/M3 需验证并收敛 Token 表达 |

### R2 保留的待验证风险

- 生产者的 ready 屏障：useDataRef/useViewTypeTool 的 useEffect 时序尚未证明安全；
- 非 JSON Ref 的兼容性、默认 isMutating=true 策略对 IDE 现有 Tool 的影响；
- 历史 Snapshot 的容量/lease/强制过期资源策略；
- 来源快照与活态 Handler 的绑定/验证能否在不改 IDE 调用形态下完成。

上述均要求在 04/05 有阶段与具名测试覆盖，不能写成已验证。

## R3 — 计划与测试阶段（2026-10-21）

### 已检查
- 04 的 M0→M1→M2→M3→M4→M5 为必经依赖链；M6 是可选阶段。
- T-01～T-16 各有场景、测试层次和里程碑测试门槛；00 的 INV-01～INV-12 全部进入 05 追踪矩阵。
- 03 的 D-01～D-09 各有相应 05 设计验证测试；M0 所需 SP-01～SP-07 在 01 有定义。
- 04/05 的 strict 阶段依赖 M3 ProjectionBarrier 证据，未在 M2 shadow 前提前宣称一致性。
- 所有文档都以 Draft 标记；本次只写 RFC 文件，没有执行实施阶段测试，不在审查日志填写 Passed。

### 全局冲突与修正

| 审查 ID | 发现 | 修正 |
| --- | --- | --- |
| R3-01 | 03 旧 SnapshotRead 类型 status=degraded 时仍可暴露 latest，调用方可能误认已准备就绪 | **已修复 03**：改判别联合，ready 才有 snapshot；degraded 仅含 lastGood/issue |
| R3-02 | 03 Workspace ID 只根据 App vector + membershipRevision；系统日志若进入投影而变化会使相同 ID 对应不同文本 | **已修复 03/05**：增加 metadataRevision，纳入 Workspace 身份与 T-09 |
| R3-03 | 03/05 用 unready App 验证 Workspace，但旧类型强制每个分量携带 appSnapshotId，形成虚假 ID | **已修复 03/05**：WorkspaceComponent 判别联合，unready/stopped 无假 snapshotId |
| R3-04 | 03 Producer 伪代码调用未在接口声明的 captureIndependentDraft/sealDraft | **已修复 03**：统一 captureDraft + nextSeq；sealPreparedDraft 仅作纯准备函数 |
| R3-05 | 03 ToolExecutionPort 与 Committer 示例引用的 ToolResult、SnapshotLease、SnapshotIssue、CommitResult 未提供最小语义 | **已修复 03**：增加相应示意型别，保留 SDK ToolResult 业务失败语义 |
| R3-06 | 03 Store 资源满、所有历史被 lease 时行为不确定 | **已修复 03/05**：定义 SNAPSHOT_CAPACITY，拒绝需要额外空间的新 commit/lease 并 degraded，T-10 验证 |
| R3-07 | M6 作为可选阶段最初缺少独立准出与 Test Gate | **已修复 04/05**：M6 也必须证明同一 Contract Suite，优化需实测基线 |

### 仍未批准 / 需实际代码验证

- 真实 Preact Hook 的 flush-ready 协调（SP-01/SP-02）；
- 现有 IDE 中非 JSON Ref/超大值比例与 Codec 策略（SP-03）；
- Strict Tool 执行与业务 Handler 最新状态验证的衔接（M4）；
- 性能、Store 容量和 lease 策略需 M0 测量后批准；
- 旧消费者迁移范围、灰度与错误隔离在实施时继续调查。

**R3 判断**：文档的阶段/测试矩阵已经有完整覆盖；设计仍保持 Draft，以上不确定性均由 M0/M3/M4 的 Gate 承担，而非在文档里假装已解决。

## Final — 文档全局静态校验（2026-10-21）

### 实际运行结果

- **结果：PASS（仅静态一致性；不代表方案代码测试通过）**。
- 7 份新建文档，最终共 1,396 行，全部以清晰标题开头且 Markdown 代码围栏配对。
- 00 定义的 INV-01～INV-12 共 12 项，05 测试追踪矩阵 **12/12**；03 D-01～D-09 共 9 项，05 **9/9**。
- 05 有 T-01～T-16 共 16 个具名测试集合；04 定义 M0～M6 共 7 个里程碑，05 **7/7** 有相应 Gate（M6 为可选）。
- 01 预研 SP-01～SP-07 共 7 项；各阶段对原子提交屏障/源数据兼容性的依赖在 04 保留。
- 文档内部 25 个相对链接全部存在；扫描识别到的本地源代码路径 26 个全部存在（只检查路径，不代表代码行为已执行）。
- 本地 Git HEAD 仍为 789ef07；本 RFC 目录以未跟踪文件形式出现。**本次工具操作只创建、写入、编辑新 RFC 目录的文档，没有触碰、reset、stage、commit 其他源码或用户的现有未提交改动。**

### 静态检查不能证明的事项

- 未编译/测试重构后的 Runtime，因为相关实现尚未动工。
- 未运行 SP-01～SP-07；ProjectionBarrier 可实现性依然是 M0 No-Go 门槛。
- 未运行 IDE E2E 与性能基线；真实成功率、时延、兼容性仍是待验证假设。
- 03 的 TS 代码片段是候选类型与伪代码，不得直接当成现有可编译 API。

### 设计当前结论

方案 C 的职责、版本规则、一致性边界、作用域、旧 Ref/Tool 行为、迁移路径和可观察失败策略已在各文档对齐。**下一次工程工作应该从 M0 的时序/兼容性 Spikes 开始，而非直接把 Strict Snapshot 功能接到 IDE 上**。

后续设计评审如改变 Commit 权威边界、AppSnapshot 版本模型、Ref/Tool 绑定规则或 Workspace 一致性保证，必须同时更新 00、03、04、05 并追加审查记录。

## R4 — M0 代码实证复查（2026-10-21）

### 执行证据

- [m0/RESULTS.md](./m0/RESULTS.md) 为本轮 M0 权威结果文档，具备复现脚本和 stdout 原始日志。
- 本地 Node v23.11.0、pnpm 10.15.1、HEAD 789ef07、保留原有未提交工作树；源码检查只读取 .ts/.tsx、实际执行代码和测试，未读取原项目旧 Markdown。
- 原有 SDK 测试 64 passed；Runtime 380 passed/3 skipped/7 todo；IDE Jest 5 passed；独立实验 26 passed（存在 Node 引擎 warning）。
- M0 SDK 4 测试、Runtime 8 测试通过。探针 assert 的是**现有问题是否存在**，不应当与设计 INV-01～12 目标通过混淆。

### M0 发现与 RFC 全局映射

| 审查 ID | 实测新信息 | 已反映到 RFC |
| --- | --- | --- |
| R4-01 | 真实 AppKernel 首次 View+DOM 先于 Ref/Tool 注册 | 01 §8、02 §10、03 §17、05 SEED-01、04 M3 Gate |
| R4-02 | 纯 Ref A→B 在无 DOM/markDirty 下不会产生通知 | 01 §8、03 §17.1、05 SEED-02、04 M3 |
| R4-03 | 同轮数据可能 Ref A/B 混用；layout-effect 微任务 PoC 仅同步路径成立 | 01 SP-02 保留限制、03 §17.2、05 SEED-03 |
| R4-04 | useArrayRef 可输出无对应集合 Ref 的 list marker | 02 §10、03 §17.4、05 SEED-04、04 M0-R5 |
| R4-05 | 真 Worker IPC 接收同毫秒丢包、不校验负载 appId | 02 §10、03 §17.3、05 SEED-05/06、04 M0-R1/M2 |
| R4-06 | SnapshotRegistry 不复制深层 payload，同内容读不同 ID | 03 原 INV-02/04、05 SEED-07/08、04 M1 |
| R4-07 | 当前活态 AppKernel Ref 与来源 Snapshot 分裂，存在 B 替 A | 01/02/03 Ref 设计、05 SEED-09/10、04 M4 |
| R4-08 | Tool Handler 失败被包装为成功 | 02 §10、03 §17.5、05 SEED-11、04 M4 |
| R4-09 | Workspace Formatter 聚合但无 revisionVector | 01/03 Workspace 边界、05 SEED-12、04 M4 |
| R4-10 | 真实小型性能数据仅覆盖 Transformer/Extractor/Formatter/Registry | 01/03/04/05 均明确“局部基线”，不批准生产指标 |

### 最新设计结论

**Conditional-Go for M1 Pure Core；strict No-Go。** 允许 M1 内存 Producer + Validator/Committer/Store 与独立 Contract Tests 先开展，但不得将该 Core 接入现有 IDE 的正式 Tool 执行路径。正式 WorkerPool 故障试验、运行时 Ref 数据兼容采样、真实工作集性能及 Node >=24 环境验证列在 04 §12 的 M0 后续清单。

### 审核原则

- 用户纠正后的主术语保持 **App / View / Ref / Tool**；仅当定位现有遗留源码/实验时允许 Operation/Action/Observation 原始标识；
- 不把 useLayoutEffect + queueMicrotask 直接宣布为生产级完整屏障；
- 任何严格模式迁移前必须先证明 05 中 SEED-01～12 的未来**目标行为断言**通过；
- 保留本地全部既有改动，不主动 stage/commit/reset；实验临时 SDK/Runtime test 文件运行后必须清理。

## R5 — M0 文档/代码证据闭环静态复核（2026-10-21）

**实际检验结果：PASS**。

- RFC 现有 8 个 Markdown 文档（含 m0/RESULTS.md），约 1,734 行；标题存在，所有 Markdown 代码围栏闭合、相对链接全部指向存在的本地文件。
- INV-01～12 在 Test Plan 12/12 全覆盖；D-01～09 在 Test Plan 9/9 全覆盖；M0～M6 7/7 具有 Test Gate，T-01～16 测试集具名存在。
- 已运行的 M0 探针记录为「现状再现/小型 PoC」，没有被错误标记为严格 Snapshot 合同通过。
- 对 22 个源码路径的本地 SHA-256 指纹复验与第一次 M0 采样完全一致。
- SDK/Runtime 暂时挂载的 5 个 __m0_* 独立探针测试文件全部已清理；工作树原有改动保持。Git 状态项数量 111，HEAD 仍是 789ef07。
- 当前推荐仍为 **Conditional-Go M1 Pure Core / Strict No-Go**。后续工程开始 M1 时，应继承原始探针与目标合同测试的区别，不提前把 M0 的观测测试改写成“系统已正确”的宣传证据。

**限制**：这是文档内部链接、映射与源码指纹的静态一致性审查，不代表已经测试或交付 M1～M5 的生产实现。

## R6 — M1 纯 Core 实施审查（2026-10-22）

**独立实现范围**：新增 runtime/src/core/snapshot/ 下纯 TypeScript 合同/校验/Store/Composer 与 3 个测试文件；未修改 SDK、Worker、Host、IDE 的现有源码，也未扩大公开包出口。完整证据为 [M1 实施报告](./m1/RESULTS.md)。

### 结果与追踪

- **M1-A～M1-E Gate：PASS**；实现 AppSnapshot/WorkspaceSnapshot、SnapshotCommitter、SnapshotStore、无 DOM 内存 Task App。
- 新 Core 合同专项：52 tests passed / 3 files，覆盖率 Statements 95.95%、Branches 87.06%、Functions 100%。
- 既有完整回归：Runtime 432 passed（包含新增 52；原 380 保持）、3 skipped、7 todo；SDK 64 passed；IDE Jest 5 passed；runtime tsc --noEmit 退出码 0。
- 从错误输入/来源序号/深拷贝/Lease 容量/历史 Ref/View generation/跨 App 组合等方面做了反例测试；业务执行由内存 App CAS 演示，**没有**宣称真实 ToolHandler 的 M4 权限已完成。
- 文档对齐：03 §18、04 §13、05 §10 都明确区分已经兑现的纯 Core 合同与 M2/M3/M4 尚未证明的生产适配约束。

### 发现并修复的设计/测试偏差

| 审查 ID | 偏差 | 处理 |
| --- | --- | --- |
| R6-01 | 恢复成与 lastGood 相同的语义内容被测试错误期待为新修订 | 修正为 unchanged，Revision 保持；保留真实内容变化才推进的约束 |
| R6-02 | 历史空间不足时测试曾不允许淘汰无 lease 版本 | 明确优先淘汰无保护历史；只有全部候选受保护时才拒绝 Commit |
| R6-03 | Producer 的 nested Ref clone 若中途失败可能无法得到来源身份，旧状态仍误标 ready | 增加受限根 envelope 读取和可信 reportPrepareFailure，将可认证的失败归属到正确 App |
| R6-04 | 仅在最终 canonicalSize 检查时阻止超大字符串，有内存放大风险 | 增加克隆阶段近似字节预算及最终精确 Snapshot 限额 |
| R6-05 | 活动 Lease 数量无限增长 | 引入 maxActiveLeases 上限及过期/释放测试 |
| R6-06 | Workspace 组合可能让 unready/degraded 混用旧成功 ID | 使用判别联合；未就绪成员没有合法 Snapshot ID，lastGood 明确只用于诊断 |
| R6-07 | 快照内容摘要的名字可能暗示可做可信认证 | 明确 fnv1a64 仅为诊断，正式 Equality 比较完整 canonical bytes，不以摘要相等视为同一语义 |

### M1 Gate 判断与后续限制

**M1 isolated Gate: PASS，M2 shadow 可以开始。Strict Snapshot/ToolExecution: No-Go。**

待验证的跨阶段风险包括：M2 IPC 通道 App instance 身份验证；M3 SDK 生命周期原子就绪；M3 真实应用 Ref codec 与 list-level marker；M4 ToolResult 跨层传播和执行时业务权限；M5 真正端到端时延、内存及 TTL 运营预算。

M1 中旧 SDK / Worker 行为未被替换，因此旧有的 Ref 错绑、ToolResult 嵌套成功、同毫秒 IPC 等既知问题仍存在于生产路径。这些是迁移工作的明确输入，不应将纯 Core 新测试通过解读为问题已经上线修复。

### R6 最终全局静态审查补充

本地脚本真实执行：**M1_GLOBAL_REVIEW PASS，issues=[]**。

- 9 份 RFC Markdown（含 M0/M1 RESULTS），互相引用的相对链接与已列出的本地源码路径均存在，代码围栏配对。
- 12/12 条 INV、9/9 条 D、7/7 个里程碑准出均在对应测试/计划文档维持一致。
- 新 Core 共有 6 个生产 TS 文件、3 个测试 TS 文件，静态扫描未发现 Preact、DOM、Worker、Node 专用模块、MutationObserver 等宿主依赖。
- 与 M0 已存的 22 份原生产源码 SHA-256 逐一比对，**全部未变化**；新 9 个文件的 SHA-256 记录于 [m1/source-fingerprints.json](./m1/source-fingerprints.json)。
- Git 仍保留用户原有未提交更改；仅新增 RFC 与 runtime/src/core/ 两个未跟踪区域。没有执行 Git stage、commit、reset。

当前推荐不变：**M1 isolated PASS → M2 shadow 可以开始；严格执行模式继续 No-Go**。

## R7 — M2 Worker Shadow / 语义独立性审查（2026-10-22）

### 已执行代码验证

M2 的 Worker/DOM 适配与旁路 Core 接收已经在本地通过编译及真实 Worker Runtime E2E；详见 [m2/RESULTS.md](./m2/RESULTS.md)。版本仍为本地 HEAD 789ef07 加既有未提交工作树。

- Core 生产代码依然只依赖纯 TypeScript 和自身文件，没有依赖 Worker、DOM、Preact、Electron 或模型 Provider。
- 新增 DomSnapshotShadowProducer 属于 Worker Adapter，不属于 Core；AppWorkerHost 的 UUID 由 Runtime 负责；Worker INIT、RESET、SNAPSHOT_PREPARED 均有实际运行测试。
- 默认关闭 Shadow，新 Producer 失败不改变旧 Fragment 缓存或 Tool 执行；启用时新 Report 不包含 Ref/Tool 业务内容，且固定 strictEligible=false。
- 真实 Worker 复用测试中，旧 Instance 与新 Instance 的 Snapshot ID 不同；另有真实 worker_threads 的错 appId / 旧 instanceId 拒收及同毫秒旧 Fragment 未配对诊断。
- 累计 Runtime 445 passed（3 skipped，7 todo），SDK 64 passed，IDE Jest 5 passed，Runtime 类型检查为 exit 0。

### 与 RFC 设计的差距

**未解决**：M3 SDK 准备提交屏障与真实 sourceEpoch；Ref-only/Tool-only invalidation；来源对象的 Typed Ref / View owner token / ToolSchema 语义等价；M2-E 逐字段 parity；遗留 SNAPSHOT_FRAGMENT 对未知 appId 的接收安全性；M4 正式 ToolInvocation 与活态授权。

**架构决策**：M2 Shadow 纵向切片通过，说明现有 Node Worker/DOM 确实可以作为 **Core 的一个适配器**；但正式 Runtime 还没有彻底去 Host/DOM/模型厂商耦合，也尚未证明当前 SDK 真正满足 Snapshot 的原子语义。

下一步选择 M3 SDK ProjectionCoordinator，而不是继续拆包或将 Shadow 提前转成 Strict。

### R7 最终静态审查与变更范围

本地审查脚本最终结果 **AUDIT PASS / ERRORS=[]**：

- RFC 当前 10 个 Markdown 文档，78 个相对文件链接目标均存在；原定义的 12 项 INV、9 项 D、7 个里程碑在测试/计划中映射一致。
- M1 的 9 个代码文件与上阶段保存的 SHA-256 指纹**全部一致**，证明本次 M2 未在纯 Core 中引入 DOM/Worker 或修改语义契约。
- 相比 M0 记录的 22 个源码指纹，本轮恰有 3 个该集合中的文件发生预期改动：worker-host.ts、worker-runtime/index.ts、spi/worker-protocol/messages.ts；第一次脚本的 expected list 遗漏了协议文件，修正审查清单后通过，不涉及源码回退或隐藏的测试失败。
- 新增 DOM ShadowProducer、ShadowReceiver 及其各自单测、WorkerHost IPC 测试和真实 Worker E2E；WorkerSandbox 的可选诊断开关与另一个 WorkerMessageType 类型定义按设计更新。
- 最新回归：Runtime 445 passed/3 skipped/7 todo、SDK 64 passed、IDE Jest 5 passed、Runtime TypeScript exit 0；日志见 [m2/regression-final.log](./m2/regression-final.log)。

**当前可下的结论**：M2 证明 Worker/DOM 可作为纯 Snapshot Core 的一个真实 Adapter；不是证明整个 Runtime 完成 Host/DOM 解耦，更不代表旧 SDK 的捕获逻辑达到了 Strict。下一步仍需 M3 的真实语义事务屏障。

## R8 — M3 SDK 语义提交协议代码与文档审查（2026-10-22）

### 已执行验证

[M3 实施报告](./m3/RESULTS.md) 与 [最终回归日志](./m3/final-regression.log) 是本轮的真实执行证据。

- Core：新增无 DOM/Worker 依赖的 SemanticProjectionCoordinator，嵌套显式提交、Epoch、microtask 合并、异常监听者隔离已有纯 TypeScript 测试。
- SDK：useDataRef、useArrayRef、useViewTypeTool 的已知语义注册采用同步 Layout Commit；40 步生命周期/重排、20 次批量 setState、typed/bare Ref alias 注册与撤销均有真 Preact + AppKernel 测试。
- Worker：真实 Worker + 真 SDK Fixture 验证 Ref-only 的 A→B 不改变 markup，默认 Legacy 和 Shadow 都能刷新；历史 Snapshot 的 Typed Ref 仍然指向 A。AppKernel 的真实 AppID 在 Worker INIT 注入。
- Tool 声明者：Root Tool 的 declaredByViewGeneration 与 target ViewType 分离；不匹配 View generation 的 stale Tool Draft 被 Core Validator 拒绝。
- M1 Snapshot Core **未修改**：与上一阶段保存的 9 个源文件 SHA-256 指纹全部相同。M3 19 个代码/测试文件的新 SHA-256 见 [m3/source-fingerprints.json](./m3/source-fingerprints.json)。

### 真实结果

| 项目 | 最终状态 |
| --- | --- |
| Runtime TypeScript Build | exit 0 |
| SDK TypeScript noEmit | exit 0 |
| Runtime 全量 Vitest | 452 passed / 3 skipped / 7 todo |
| SDK 全量 Vitest | 72 passed |
| IDE Jest | 5 passed |
| RFC 静态链接与范围审查 | PASS：当次 11 份 Markdown、85 条存在的相对链接，12/12 INV、9/9 D、7/7 里程碑映射 |

### 本轮 Review 发现与处理

| 审查项 | 事实 / 风险 | 处理 |
| --- | --- | --- |
| R8-01 | Layout 注册可消除 M0 初帧 Ghost Ref，但单纯修改注册 Hook 不会让 Ref-only 自动刷新 Worker | AppKernel 独立语义 Epoch + Worker 对 Epoch 的订阅；即使 Shadow 关闭，legacy Ref IndexMap 也刷新 |
| R8-02 | useArrayRef 类型化列表和元素 marker 以前没有对应 Registry 键 | 注册 typed list/item 与 bare aliases；新增重排、Type 变化、删除与空列表测试，保留 SDK DX |
| R8-03 | Tool 的声明 Root 被误当成执行目标 FileDetail，历史 identity 风险 | ViewTypeTool 显式携带 declaredByViewId + generation，target viewType 单独处理；旧 generation Draft 被拒 |
| R8-04 | 真实 Worker 初始化的 AppKernel._id 为空，SDK Context、Tool prefix 有身份错误 | Worker INIT 调用 AppKernel.setId(appId)，用真实 Worker E2E 断言 |
| R8-05 | SDK 上一次阶段中间 typecheck 失败：新增 generation 被推断为 string/null | 修正 View Context 为已赋值的非空 generation，重新运行全量 Runtime/SDK 类型检查与测试，最终全部退出码 0 |
| R8-06 | 40 步状态、20 次批量提交正常，不等于任意异步/错误恢复具备严格原子性 | 保持 Shadow 报告 producerConsistency=unverified、strictEligible=false，严格模式继续 No-Go |
| R8-07 | Ref alias 与列表级 Ref 大幅增加复杂应用的数据量风险 | M3-G2/T-13 设内存/性能预算与 Codec 研究为强准出项，不隐瞒资源代价 |

### 阶段性结论

**M3-A / M3-B 常规语义注册与刷新 / M3-C View generation / M3-D 已知 Typed Ref、Tool origin 切片：PASS。整个 M3 Strict Gate：NO-GO。原始 P0 的 Ref 统一来源执行和 ToolResult 业务失败仍然未在生产执行链修复。**

本次审查没有以测试全绿代替未实现的生产能力；未 stage、commit、reset 用户既有工作树。下一阶段必须用异常/跨异步 CommitBarrier、Ref Codec/Marker Validator、Tool Schema 同构性以及 IDE 真实 Shadow E2E 决定是否可以推进 Strict / M4。
## R9 — View 自治 Tool 的最小可证 Core 实施审查（2026-10-22）

见 [方案 B](./07-view-owned-tool-identity-proposal.md) 与 [M4 前置报告](./m4-preflight/RESULTS.md)。

- **实现范围**：仅 runtime/src/core/tool/view-owned-tools.ts 与同目录测试为本轮新增生产/测试代码；未修改旧 SDK/Worker/AppKernel/IDE 路由，也未变更 M1 Snapshot Schema。无新包或依赖。
- **合同测试**：19 passed；覆盖率 97.02% statements/lines、91.95% branches、100% functions。处理了最初 Vitest 函数异常 Matcher 不兼容引起的 5 项测试自身失败；重新运行全部通过。
- **全量回归**：Runtime 471 passed / 3 skipped / 7 todo、SDK 72 passed、IDE Jest 5 passed、Runtime/SDK TypeScript 退出 0。
- **正确性证据**：ViewInstanceId 由 Runtime 纯 Core 发行，旧 View 重挂载不复活；同类型 80 个 View 分别拥有 Handler 但只聚合一条公开 Tool；enabled、旧 release、旧 binding 版本不会误删/误调其他实例；Handler 业务失败原样返回。
- **尚需迁移/安全门槛**：当前 invoke 只用于内部预演，不能替代可信来源 AppSnapshot 与运行时身份校验。M1 Schema 尚无绑定 targets；旧 Resolver 的活态 fallback 与旧 AppKernel 外层 success:true 包装仍是正式 M4 的 P0；真实 IDE 文件/权限 CAS 尚未完成。

**M4-preflight Stage 0 = PASS；Production M4 / Strict = NO-GO。** 继续 Stage 1 的 Runtime/SDK 最小适配和兼容测试，不执行大规模 IDE Tool Handler 重写。


## R10 — M4 Stage 1/2：View-owned Tool 与 Snapshot V2 严格边界审查（2026-10-22）

[Stage 1 完整结果](./m4-preflight/STAGE1_RESULTS.md) · [Stage 2 完整结果](./m4-preflight/STAGE2_RESULTS.md)。

**实际通过的证据**：
- 原 ViewId 公开地址保留；Runtime 在 View 真实挂载时签发实例身份。同类型 View 可以分别维护 Handler 并在 Agent 层聚合定义，但 Stage 1 新 Tool 在正式安全调度之前不渲染为可调用 tool-ref。
- Snapshot schemaVersion=2 是有版本的正式 Core Draft/Store 结构（不污染 V1 数据结构）。Ref/Tool targets 与本次 ViewInstance 必须完全一致，工具注册版本变化推进 Core Revision；历史 V2 数据被冻结，旧 fd_0 不会自动绑定新实例。
- Runtime-only acquireToolSource 从已提交 Snapshot 的 Lease 获取 Tool 的真实来源，并与当前 committed App/Tool metadata 交叉比对；它不执行 Handler，也不将客户端自由 Tool JSON 当权限令牌。
- 真实 Worker/SDK Shadow V2 Ref-only、Tool-only、View close/reopen E2E 通过，重复 4 次均通过；默认旧 Agent IndexMap 不接新 Tool。
- 最终回归 Runtime **497 passed / 3 skipped / 7 todo**，SDK 84 passed，IDE Jest 5 passed；Runtime/SDK/IDE tsc 均 exit 0。
- 新 V2 validator + source-binding Core 两文件定向覆盖率 94.71% statements、85.58% branches、100% functions。V2 synthetic 100-View p50 10.974ms（V1 5.298ms），明确成为性能 Gate 风险。

**变更审查**：Stage 2 有意修改了 M1 的 types/store/index 引入 V2，不能声称过去 M1 文件 SHA-256 一致；Stage 2 的 V1 严格解析保留并由全量旧测试证实。新 V2 校验的 V1 代理只用于复用成熟 Schema/大小验证，不进入 Store，未来需评估这份额外克隆的性能成本。

**仍属 P0/M4 风险**：正式 Agent Tool Router 仍旧，尤其 AppKernel.callTypeTool 的 success:false 外层包装成功尚未修复；业务授权/文件状态 CAS/工具 Schema 完全一致性、真正 SDK 异常提交屏障、IDE fd_index 位置型 ID 与真实 IDE LSP 负载尚未通过。

**R10 结论：Stage 1 PASS；Stage 2 版本化可信 Snapshot 只读纵向链路 PASS；生产 Strict 和 M4 正式 Tool 执行仍 NO-GO。** 没有 Git stage、commit、reset。


## R11 — Stage 4 正确性与最小化性能审查（2026-10-23）

[实施报告](./m4/stage4/RESULTS.md) · [最终回归](./m4/stage4/final-regression.log)。

- **更高优先级的真实 P0 回归**：过去 WorkerHost 按毫秒 timestamp 去重，导致相同毫秒的第二条合法 Fragment 丢失；现在按绑定 Worker、App/实例身份及显式递增 captureSeq 接收，真实 Worker 的前后两个 Fragment/Shadow 配对都正确。Shadow OFF 的默认 Legacy 路径也有拒绝伪来源回归。
- AppKernel 不再把 malformed success:"false" 误认为普通 raw data 而包装成功；现业务状态异常明确 TOOL_RESULT_INVALID，raw 无 success 的旧 Handler 保留兼容。
- 实际 IDE fileSystemService.createFile 使用 Node fs 排他 wx，不再先 access 再默认写入；8 个同时创建同名文件只有 1 个成功。create_file 后续 View/持久化/事件失败只附带 warnings，不谎报磁盘创建失败，也不生成假的 fd 公开 ID。
- V2 的 V1 校验代理从 V2 已验证的 copyJson 数据构造，不再进行第二次复制；V1 public input 仍执行完整原始严格复制。全部历史 Snapshot、Ref/Tool 及 adversarial 测试没有退化。
- 完整 Runtime 509/SDK 84/IDE 14 tests passed；三个包 TypeScript 全部 exit 0。V2 合成 100 View 优化前 p50 10.974ms，当前三轮复测 p50 8.987–9.551ms；两组在不同时间执行，非严格 A/B 同批测试，更不能冒充真实 IDE 性能。
- **不准过度外推**：Legacy Worker 缺 AppInstanceId 时仍使用物理通道兼容，Mutating Tool 仍缺 V2 来源/资源 CAS；IDE 文件创建的排他性不是现有文件修改的 CAS。严格 SDK 捕获事务、业务写入验证及独立 Host 仍是 No-Go。

该阶段源改动包含 runtime/src/core/snapshot/validator.ts、v2-validator.ts、Host/Worker 及 TypeTool 结果检查、IDE 创建文件/工作流/测试。没有新增依赖，没有替用户提交或重置其他文件。
