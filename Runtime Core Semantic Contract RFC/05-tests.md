# RCSC-05 — 测试策略、合同矩阵与准出计划

- **状态**：Draft / Test Plan Only；目前没有因本 RFC 而新增或执行生产代码测试
- **依据**：[00 不变量](./00-charter.md) · [01 Spikes](./01-feasibility.md) · [03 协议](./03-design.md) · [04 里程碑](./04-plan.md)
- **总目标**：证明 App/View/Ref/Tool 的一次已提交观察具有不可变、一致、版本明确和不误执行的行为，并证明 IDE 保持原有开发方式。

## 1. 测试方针

1. **契约优先**：先给出各项 INV 和 D 的成功/拒绝语义，再测试当前内部实现。
2. **负例优先**：针对错 Ref、幽灵 Ref、Tool 失效、乱序 IPC、ABA、TTL 与故障注入构造反例。
3. **Core 无环境依赖**：纯 Core 测试必须能在不创建 document、Worker、Preact 的环境通过。
4. **Adapter 单独验证**：真实 Preact Hook/DOM/Worker 只用于验证 SDK 和 Producer 实现是否满足同一契约。
5. **状态与副作用分开**：不能把 Snapshot 只读一致性当作外部文件系统写入的事务保证。
6. **测试真实性**：脚本计划不是通过报告；记录实际命令、退出码、用例计数、提交/环境和失败输出。
7. **严格结果传播**：业务 Handler 拒绝必须保持失败，不允许因为 IPC 成功就覆盖业务状态。
8. **版本回归**：legacy、shadow、strict 的混用场景是重点，不能在旧 binding 执行失败后通过新状态自动重绑。

## 2. 测试分层与运行环境

| 层次 | 运行环境 | 主要验证 | 不允许替代 |
| --- | --- | --- | --- |
| L0 Pure Core Contract | Node/Vitest + 内存 Producer，不引入 DOM/Worker | 数据复制、Validator、Committer、Store、Ref/Tool 绑定 | 不准以 Mock SnapshotFormatter 代替真实 Validator |
| L1 Producer/SDK Integration | Preact + linkedom / 测试 DOM | useEffect/layoutEffect、View 注册、Ref/Tool 一致捕获 | 不准只手写模拟 HTML |
| L2 Runtime IPC / Worker | 真实 Worker 或受控 IPC harness | instanceId、producerSeq、失败、重启、乱序、race | 不准只以 timestamp mock |
| L3 IDE App E2E | 临时工作区 + SDK + Runtime + IDE，LSP 可配置 mock 或真实 | 目录、打开/关闭文件、编辑、搜索、LSP 状态与 Snapshot | 不准只检查 Markdown 文本包含关键字 |
| L4 Performance/Resource | 固定环境、参数化多 View/Ref/Tool、受控采样 | p50/p95/p99、内存、拷贝代价、lease 预算 | 不以没有基线的绝对数作为“改善”证据 |

## 3. 基准 Fixtures

### Fixture A：无 DOM 内存 App（核心验收）

纯 TypeScript 维护业务对象 Task-A/Task-B，定义一个 View、两个 Ref，以及一个 ViewTypeTool 完成任务；Producer 直接发 Draft，不导入 Preact/DOM/Worker。支持 reorder、rename、remove、recreate、tool enabled/disabled、view remount。仅 Core 必须可以执行完整读写与失效判定。

### Fixture B：SDK 时序 App

真实 createTUIApp / View / useDataRef / useArrayRef / useViewTypeTool；可控 deferred Promise 让 Hook 注册、DOM commit、View mount/unmount、Tool enable/disable 交错。记录 mutationEpoch、producerSeq、SDK Registry 版本及每一次 Prepared Draft 的校验结果。

### Fixture C：Fake IPC / Worker Lifecycle

模拟同毫秒 N 次变化、重复序号、倒序包、旧实例晚到、部分/非法 Draft、Worker 重置、新实例使用相同 appId 与 viewId。通过真实 Committer 验证“不接收坏包、不回退 revision”。

### Fixture D：IDE 真实路径

临时 git-like 源码目录（不写开发者真实工作区），至少包含 ts/json 多文件；通过 IDE 打开/编辑/重命名/关闭多 View，触发搜索和可控 LSP success/loading/error。检查当前 View、Ref、Tool 元数据与执行结果，而不是只比较渲染文本。

## 4. 具名测试集（必须实施）

### T-01 · 不可变与序列化验证（M1/M4）

- 调用方先创建原始 Draft，commit 后修改原始对象、数组和嵌套对象；已提交快照必须完全不变。
- 尝试修改 Store 返回的对象/嵌套字段；不可改变内部值。
- getter/accessor、副作用 getter、循环引用、symbol 键、函数、BigInt、NaN/Infinity、Date/Map/class instance/sparse array 分别被拒绝或显式 Codec 转换；拒绝路径含字段名。
- 测试键名 __proto__ / constructor / prototype 的安全编码，不触发对象原型污染。
- Tool Schema、Ref payload、View content 都走同一安全复制协议，但可使用不同的 size budget。
- Validator 失败不得改变 latest、revision、Ref/Tool Binding。

### T-02 · Commit Version / Fingerprint / No-op（M1/M2）

- 同一合法语义 Draft 两次成功准备，若内容一致、instance 不变，读取 ID/revision 不变化。
- 改变 Ref payload、Tool schema/visible 或 View generation（即使 Markup 不变）必产生新 revision。
- 同一毫秒多次 producerSeq 变化不丢最后有效提交。
- 无效 draft、过期 producerSeq、不同实例来源不推进成功 revision。
- 先验证再同步 CAS，注入竞争更新后旧 Draft 不可覆盖新 commit。
- fingerprint 不能仅依赖 Markup 或 32-bit 非抗碰撞摘要作为身份判定。

### T-03 · IPC 顺序 / 实例世代（M2/M4）

- 发送 instance_A seq=1、seq=3、seq=2、重复 seq=3；结果只接收有效向前来源。
- Worker 关闭并重启 instance_B，延迟 instance_A 包到达；新实例快照不得被覆盖。
- 伪造/未知 appId、instanceId、schemaVersion、seq 非安全整数；拒绝且记录错误。
- WorkerPool 复用物理线程后逻辑 instanceId 更新；旧 Ref/Tool Handler 无法被新实例错误复用。

### T-04 · SDK Projection Barrier / Ghost Ref（M2/M3）

- DOM 已出现 Ref 文本而 Ref Hook 尚未完成注册，不得发布合法却缺 Ref 的 Snapshot。
- useDataRef (effect) 与 useArrayRef (layoutEffect) 混用、异步 re-render、快速反复 mount/unmount、Tool enable 交错，Draft 一致或明确拒绝。
- 只替换同名 Ref payload 而 DOM 无文本变化，仍发出可见的语义修订。
- 只更新 Tool schema/可见性而 View 内容不变，仍推进语义版本。
- capture 期间 mutationEpoch 变化，有界重试，不提交 torn Draft；持续高频变化最终返回 PREPARE_BUSY。
- LSP Pending 不阻塞任意业务异步完成；loading/success/error 每一个可单独提交有效状态。

### T-05 · View Identity、Generation、ABA（M1/M3）

- View fd_0 关闭再重建同名 fd_0：generation 不同；旧绑定拒绝 VIEW_INSTANCE_REVOKED。
- dynamic View list 头部删除使其他 ID 重排，旧 snapshot 仍绑定原对象或明确拒绝，不误关/误改其他文件。
- 同一 View ID 在同一次 Draft 重复出现：Validator 拒绝；旧已提交 Snapshot 不受影响。
- Root 声明 FileDetail ViewTypeTool 但目标动态出现/消失，定义 owner 与目标身份判断正确。

### T-06 · Ref 来源解析与业务 TOCTOU（M4）

- 同名 refId 在两个 View：要求明确复合来源键，永不使用后缀遍历的“第一个”结果。
- 旧快照 ref pending[0] 是 Entity-A；新快照重排后 pending[0] 是 Entity-B；旧调用不能作用 Entity-B。
- 删除/重建同 entityId 同展示内容，若 entityVersion 不同应拒绝；无实体版本默认写入 fail-closed。
- Snapshot-value Ref 返回旧观察的独立值；不能取最新活态对象替代。
- 在异步输入校验、Ref 解析与进入 Handler 之间插入业务对象变化；最终再检查以阻止写入竞态。
- 普通字符串恰好等于某 Ref ID 时，若输入字段不是 reference 类型，不得被自动替换。

### T-07 · ViewTypeTool Identity / Schema / Visibility（M3/M4）

- Root 声明作用于 FileDetail 的 Tool，可在目标 View 挂载后被正确发布与执行。
- 同 App 不同 ViewType 的同名 Tool，不冲突；跨 App 同名 Tool，不覆盖。
- Tool hidden/unregistered、View 关闭、Handler 变更/Schema 不兼容时旧来源调用拒绝 TOOL_UNAVAILABLE/TOOL_SCHEMA_CHANGED。
- 显式 isMutating=false 与默认 true 的执行政策不同；未声明只读不自动放宽旧版本检查。
- Tool descriptor 不包含函数/闭包；Snapshot 可 JSON 复制。
- 无合法 Tool target（比如没有对应可执行 View）时，不能因为只存在一个注册名就自动指定对象。

### T-08 · ToolResult 语义与副作用不确定（M4）

- Handler success=false/error=BUSINESS_DENIED 的结果不会在 AppKernel/Worker/Core 被重包为 success=true。
- 正常工具成功与传输成功必须分开表达。
- 执行前超时/取消应明确拒绝；进入外部副作用之后结果未知时标记 UNKNOWN，不保证 exactly-once，也不能盲目自动重试写入。
- 执行日志带来源 snapshotId、toolId、viewGeneration、result status，默认不泄露敏感输入内容。

### T-09 · WorkspaceSnapshot Vector（M1/M2/M4）

- App-A revision=5、App-B revision=8、App-C unready 组合：ready 分量指向完整已提交 Snapshot，unready 分量仅保留明确健康态，不伪造 snapshotId/revision。
- 某个 App 变更时只替换对应分量，Workspace 版本推进；并不要求其他 App 同步提交。
- App 删除/重启，同 appId 的 instanceId 改变，membership 变化被反映。
- degraded App 不可在 Workspace 中伪装 ready；lastGood 仅供诊断且带状态。
- 同 vector + membershipRevision + metadataRevision 重复读取不产生新组合版本 ID；仅更新系统日志/元数据且它们进入工作环境投影时，metadataRevision 改变并产生新 ID。

### T-10 · Store Retention / Lease / TTL（M1/M4）

- latest 不因一般读者 release 变成 undefined；旧 snapshot 按策略 retain 可读。
- 历史达到 TTL/容量边界时返回 SNAPSHOT_EXPIRED；不改查 latest，也不对 ref 自动重绑定。
- pin 满预算时新 Commit/lease 返回 SNAPSHOT_CAPACITY，App 进入 degraded（不得假称 ready）；不悄悄驱逐承诺中的有效 lease，也不破坏 Store 的 lastGood 指针。
- 并发读/释放/Commit、App 删除、Store shutdown 无资源泄漏；使用 Fake Clock 使测试确定。
- 触发硬 TTL 时若 Tool 尚未进入 Handler，必须拒绝；已进入 Handler 时不谎称副作用被撤销。

### T-11 · legacy/shadow/strict 隔离与回退（M4/M5）

- shadow 只验证/比较，绝不执行第二次有副作用 Tool。
- Strict Ref 不存在、Snapshot 过期、Tool revoked 后不 fallback 到 legacy Registry 写入。
- 在实例/会话边界切换模式，旧 snapshotId 不跨模式使用。
- 回退不会修改 App 的业务状态，也不会使同 invocation 被执行两遍。
- 格式化的 legacy IndexMap 是 committed Snapshot 的**单向派生视图**，不能向 Core 反写 Ref/Tool。

### T-12 · IDE End-to-End 回归（M5）

- 初次无 Workspace → add folder → SearchResult → multi_open_file → FileDetail × N → edit_file → file_changed → LSP 状态刷新 → close/reopen View。
- 检查 Snapshot 中当前 Views、Refs、ViewTypeTools 与真实 IDE 状态一致；包含 Tool disabled/hidden 的边界。
- 删除/重命名和其他 View 更新期间不会作用到错文件；绝对路径 Tool 行为不在本 RFC 修改业务权限模型。
- 正常、可控失败、超时、Worker restart、degraded/recovered 均有 E2E 观察和错误码断言。
- 运行在临时目录和模拟 LSP 服务；真实 LSP 可做独立可选集成，避免环境依赖破坏稳定回归。

### T-13 · 性能、容量和延迟（M0 基线 / M5 准出）

- 记录不同 View、Ref、Tool 数量（建议 1/10/50/100 View；其他维度独立变化）的 capture、serialize、IPC、validate、commit、Workspace compose 时延。
- 记录峰值/稳态 RSS、SnapshotStore 保留 bytes、深拷贝成本、失效重试数、消息总字节。
- 和 M0 旧路径比较 p50/p95/p99，统一硬件、工作集、热身、样本数；将硬预算作为评审记录，**不得在缺少基线时声称已达标**。
- 不以牺牲 INV-01～12 换取性能；若出现超预算，定位具体环节后登记 M6 优化。

### T-14 · Property-based / 状态机测试（M1/M3/M4）

- 用固定 seed + 可复现 shrink 路径生成随机 open/close/reopen/reorder/remove/rename/tool enable/disable。
- 每次 commit 后断言所有 Ref.ownerViewGeneration 都存在、Tool target scope 不歧义、revision 严格前进、old snapshot immutable。
- 任意随机序列中旧 Ref 不应指向新对象；执行失败不能造成测试业务仓库写入。
- 并行随机生成 Worker 消息顺序与多次 invalidation，断言 Store pointer never regress。

### T-15 · 已知 Ref Marker 与文本投影边界（M3/M4）

- SDK 输出的已知 Ref token 可与注册 Ref 映射；没有对应 Ref 不发布成功。
- Markdown 普通链接、代码示例中的伪 ref、转义语法不被错误提升为真实 Ref。
- 当前 useDataRef / useArrayRef 使用字符串输出；若无法完备识别，在严格模式收敛 Token 或 fail-closed，不允许“所有文本 Ref 均被验证”的虚假声明。
- View 片段 kind instruction/state 的判定须基于明确语义，不能因子节点包含 data-role 而吞掉整份动态 View。

### T-16 · Health / 错误诊断 / 恢复（M1～M5）

- 首次成功前状态 unready；合法 commit 后 ready；校验失败 degraded；成功恢复重回 ready；App 关闭 stopped。
- degraded 时 lastGood 明确仅作诊断，默认 mutating Tool fail-closed。
- SNAPSHOT_PREPARE_BUSY、SERIALIZATION_ERROR、REF_AMBIGUOUS、TOOL_SCHEMA_CHANGED 等错误携 App/View/Ref/Tool path 与修复建议。
- 重试并恢复后不复活旧 View/Tool binding、不回退 revision、不吞日志。
- 错误日志不打印敏感 Ref payload 全量数据，且排除跨 App 数据泄漏。

## 5. INV / 设计校验的追踪矩阵

| 不变量 | 对应测试 | 首个必须通过的阶段 |
| --- | --- | --- |
| INV-01 同源一致性 | T-02、T-04、T-15 | M3 |
| INV-02 发布后不可变 | T-01、T-14 | M1 |
| INV-03 实例与单调版本 | T-02、T-03 | M2 |
| INV-04 不变重复读相同 ID | T-02、T-09 | M1/M4 |
| INV-05 Ref 确定解析 | T-05、T-06、T-14 | M4 |
| INV-06 Tool 确定寻址/Handler 分离 | T-07、T-08 | M4 |
| INV-07 失败不部分发布 | T-01、T-02、T-16 | M1 |
| INV-08 Workspace 组合语义 | T-09 | M4 |
| INV-09 过期、撤销、重启 | T-03、T-05、T-10、T-11 | M4 |
| INV-10 无 DOM Core 测试 | T-01、T-02、T-09、T-10 | M1 |
| INV-11 结果真实性 | T-08 | M4 |
| INV-12 Tool 可见≠可执行 | T-06、T-07、T-08 | M4 |

| 03 文档设计校验 | 对应测试 |
| --- | --- |
| D-01 来源/schemaVersion | T-02、T-03 |
| D-02 View 身份与生命周期 | T-05、T-14 |
| D-03 Ref 作用域/序列化 | T-01、T-06、T-14 |
| D-04 Tool 身份/Schema/声明位置 | T-07 |
| D-05 Ref Marker 绑定 | T-04、T-15 |
| D-06 严格纯数据 | T-01 |
| D-07 容量预算 | T-01、T-10、T-13 |
| D-08 Ref/Tool 冲突 | T-06、T-07 |
| D-09 非 DOM 更新也生成语义变更 | T-02、T-04 |

## 6. 各里程碑 Test Gate

| Gate | 必需通过的测试 | 额外证明 |
| --- | --- | --- |
| M0 | SP-01～07 探针（未必一次成功，但必须产出证据） | 基线性能、已知兼容问题、Go/No-Go |
| M1 | T-01、T-02、T-05、T-09、T-10、T-14、T-16 的纯核心子集 | Core 完全无 DOM/Worker 依赖 |
| M2 | T-02、T-03、T-04 Producer 影子诊断、T-09、T-16 | sourceSeq/instance 有效，legacy 行为未变 |
| M3 | T-04、T-05、T-07、T-14、T-15、T-16 | 统一 Hook 提交屏障无 Ghost Ref |
| M4 | T-01～T-12 适用完整集 | 来源绑定执行正确，strict 无错误 fallback |
| M5 | T-12、T-13 及全部 Contract 回归 | IDE 主要工作流、性能预算、灰度回退证据 |
| M6（可选） | 受影响的 T-01～T-16 回归及新增适配专项 | 另一 Producer 通过同一 Contract Suite、优化有基线证据 |

**严格准出规则**：任何 T-05/T-06/T-07/T-08 的错误绑定、错误执行、错误成功结果都属于阻断级。不能以“只是偶发”“重试后成功”豁免。

## 7. 执行、环境与报告格式

计划在实现阶段基于当前 package.json 核对真实命令；仓库已使用 Vitest，在相关 SDK/Runtime package 中有 test:run 与 build 脚本。不得因为此文档写了命令就声称测试已经运行。

每份测试报告至少包含：

~~~text
Test Run ID:
Git HEAD + working tree/code version:
OS / Node / pnpm versions:
Command:
Exit code:
Test count / pass / fail / skip:
Seed + shrink path (property tests):
Snapshot schemaVersion:
App instance / commit revision:
Main failure evidence:
Performance summary (if relevant):
Known limitations / follow-up owner:
~~~

**结果状态必须清晰标注**：Not Run / Passed / Failed / Blocked / Flaky. 基础设施失败与产品契约失败需要单独分类；后者永不由重跑覆盖原始失败记录。

## 8. 回归范围外与防止测试误导

- 不宣称 LSP/文件系统外部写入由 Snapshot 自身提供原子事务；需要 App 最后时刻验证。
- 不把已有 experiments/semantic-kernel 的 Action/Observation 通过当成正式 Runtime ViewTypeTool 测试通过。
- 不以 HTML 中包含 Markdown 引用字符串当作 Ref 一致性的充分证明。
- 不在用户真实仓库执行会覆盖或删除文件的 IDE E2E；所有副作用在临时受控工作区发生。
- 不因 GitHub 默认分支与本地工作树不同就假设已完成测试，所有结论锚定本地代码快照。

**测试计划结论**：以纯 Core Contract Tests 建立不可妥协的不变量，再用 SDK Producer、Worker IPC、IDE E2E 验证适配实现；测试结果本身必须可重复、可追溯、可审计。

## 9. M0 实测发现对应的确定性回归种子

以下是直接从当前本地生产类与 SDK 实测得到的 **未来目标测试种子**。当前探针通过表示“当前行为已经稳定复现”，不是说新 RFC 的目标行为已经满足。运行证据见 [m0/RESULTS.md](./m0/RESULTS.md)。

| 种子 | 当前观测 | 新合同期望 | 合同归属 |
| --- | --- | --- | --- |
| SEED-01 | AppKernel.onOpen 时 DOM/View 已就绪，但 Ref/Tool passive Effect 仍未注册 | 只能提交已准备好的完整 View/Ref/Tool；首轮禁止 Ghost Ref | T-04 / INV-01 |
| SEED-02 | 仅 Ref 数据 A→B，DOM 和 markDirty 均无更新 | 新的语义修订必须产生，无 DOM 变更也可发布 | T-02、T-04 / INV-03、INV-04 |
| SEED-03 | 同轮列表项 Ref=B、单 Ref=A，出现混合状态 | 拒绝 torn Draft 或重新准备直到就绪 | T-04、T-14 / INV-01 |
| SEED-04 | SDK 输出 useArrayRef list-level marker 而无对应 list Ref | 显式显示标记与真正集合 Ref 语义区分；严格模式不出现幽灵链接 | T-15 / D-05 |
| SEED-05 | WorkerHost 丢弃同毫秒的第二个 Fragment | instanceId+producerSeq 权威排序，绝不依赖 timestamp | T-03 / D-01 |
| SEED-06 | 人工 Worker 消息带 app_other 却被绑定 app_0 的 WorkerHost 接受 | 校验物理通道/逻辑来源 appId/instanceId；拒绝非法 sender | T-03、T-16 / D-01 |
| SEED-07 | SnapshotRegistry 将 mutable nested object 保存在 indexMap 并被外部修改 | commit 后深度复制、冻结且与来源对象隔离 | T-01 / INV-02 |
| SEED-08 | 未变 Markup/Ref 重复 Registry.create 产生不同 Snapshot ID | 重读同一已提交版本复用 Snapshot ID | T-02 / INV-04 |
| SEED-09 | 历史 Snapshot Ref=A，但当前 AppKernel Ref=B，Tool 调用选择 B | 以源快照 Ref identity 解析，再执行活态约束；不可误绑定 | T-06 / INV-05 |
| SEED-10 | 两个 View 同名 Ref，空 scope 后缀回退选择第一条 | Ref 必须精确作用域，禁止全局模糊回退 | T-06 / D-03、D-08 |
| SEED-11 | ViewTypeTool Handler success=false，被外层包装成 success=true | ToolResult 保留真实业务成功/失败 | T-08 / INV-11 |
| SEED-12 | Formatter 可组合多个 App，但没有 instance/revision vector | WorkspaceSnapshot 带分量版本和健康态 | T-09 / INV-08 |

**实施要求**：以上种子在未来新 Core 的契约测试中必须表达为“目标行为断言”，不能直接复制 M0 现状探针里对错误行为的 expected 值，否则会出现“错误被测试保护”的反模式。

### 本次真实执行状态

- SDK 全套：64 passed；Runtime 全套：380 passed、3 skipped、7 todo；IDE Jest：5 passed；独立实验：26 passed（Node engine mismatch warning）。
- 新探针：SDK 4 个测试通过、Runtime 8 个测试通过；只是现状复现/小型 PoC。
- 尚未完成：正式 WorkerPool 生命周期端到端、真实 Ref payload 动态采样、真实 IDE 大工作集性能、M1～M5 新 Core Contract Tests。
- 所有测试日志、源代码、重跑脚本和偏差说明保存在 RFC `m0/`，不得把当前正常 full suite 通过率误作严格 Snapshot 实现完成度。

## 10. M1 真实测试执行及合同范围（2026-10-22）

[M1 实施报告](./m1/RESULTS.md) 与 [覆盖率日志](./m1/coverage-final.log) 为本节实际执行证据。

- **已执行：** 纯 Core 新增 52 项契约测试通过，覆盖数据序列化、View/Ref/Tool 身份校验、单调 Revision、same-content 重用、跨版本 Ref 精确解析、View generation、历史 Lease/TTL/容量、App 停止重启、degraded lastGood、Workspace vector、内存 App 业务版本验证。
- **回归：** Runtime 432 passed/3 skipped/7 todo；SDK 64 passed；IDE Jest 5 passed；runtime tsc --noEmit exit 0。
- **覆盖率：** 新 Core Statements/Lines 95.95%、Branches 87.06%、Functions 100%。不等于整个 Runtime 仓库覆盖率。
- **仍未执行：** T-03 正式 Worker/IPC、新 SDK 真实 ProjectionBarrier 全部场景、T-08 ToolResult 跨层修复、T-11 strict/legacy 兼容、T-12 IDE E2E、T-13 同负载真实性能。因此 INV-01/06/11/12 的完整生产链尚未准出。

### 10.1 已验证矩阵（只指 M1 可覆盖部分）

| 不变量/测试 | 纯 Core 验证结果 | 仍需其他阶段 |
| --- | --- | --- |
| INV-01 / T-01、T-02、T-04 | Draft Schema 的自洽性及失败不发布通过 | M3 捕获时序一致性 |
| INV-02 / T-01 | JSON 严格复制、深度冻结、源对象修改隔离通过 | M2 真 IPC wire copy |
| INV-03/04 / T-02 | app instance、序号、source epoch、revision/no-op 通过 | M2 Worker 源头身份 |
| INV-05 / T-05/06/14 | 同名 Ref、历史列表重排、View generation、删除重建 Source Ref 定位通过 | M4 活态执行/业务 CAS |
| INV-06 / T-07 | ToolDescriptor/schema/owner/visible 在纯值层验证通过 | M4 Handler/权限 |
| INV-07 / T-01/02/16 | 不合法拒绝、lastGood、degraded、容量恢复通过 | M2 Producer FAIL wire |
| INV-08 / T-09 | 已提交 App vector + unready/degraded + membership/metadataRevision 通过 | M4 正式 Desktop |
| INV-09 / T-10 | Lease/TTL、历史保留、活动 Lease 上限、实例重启通过 | M2 运行时清理/故障注入 |
| INV-10 | 无 DOM/Worker/Preact 生产依赖，内存 App 可运行 | 实施阶段持续守护 |
| INV-11/12 / T-08 | **本次未实现**业务 ToolHandler 调用；没有虚假报告通过 | M4 ToolResult/最终执行权限 |

**验收解释**：M1 的 test/pass 不应被挪用到 M2/M3/M4 的集成 Gate。所有仍未验证的部分必须以明确的未完成状态保留在后续阶段计划。

## 11. M2 Shadow 实际测试与下一阶段合同缺口（2026-10-22）

[M2 实施报告](./m2/RESULTS.md) 与 [Runtime/SDK/IDE 回归结果](./m2/regression-final.log) 是实际执行证据。

- Runtime 全套测试达到 445 passed/3 skipped/7 todo（含 M1 的 52 项和 M2 新增的 13 项）；Runtime TypeScript noEmit exit 0；SDK 64 passed；IDE Jest 5 passed。
- M2 新测试涵盖：DOM View/Ref/ViewTypeTool → M1 Draft、Tool Schema 最小转换、View Node generation、错误 Ref owner、错源/乱序/无效 Draft、初次 PrepareFailed 与 degraded、不含业务 Tool 的只读指标。
- 使用 esbuild 临时编译**实际 Worker Runtime**并加载测试 App，验证 Worker 初始化/旧 Fragment/Shadow Prepared/Core 发布，含**同一物理 Worker RESET 后新 AppHost 实例重新发布 Revision 1**。
- 实际 worker_threads 验证 Shadow 分离来源身份、旧同毫秒 Fragment 丢帧、新 Prepared 序号持续前进；新的配对计数能够识别 matched/unpaired 帧。
- Shadow 报告固定 strictEligible=false、producerConsistency=unverified，防止测试只检查 Core health=ready 就误判已实现 SDK 语义提交屏障。

**仍然缺少的 Gate**：T-04 全面的 SDK 初次 Effect/快速挂卸载/Ref-only 不变 DOM 协调；T-06/T-07 真正来源绑定执行；T-08 ToolResult 业务失败修复；T-09 正式 Workspace 接线；T-11 legacy/strict 全面隔离；T-12 真实 IDE 多文件 E2E；T-13 实际 IDE Shadow 资源预算与新旧同工作负载对比。

M2-E 当前仅能做同一次捕获下的数量级一致性诊断，而非 Ref payload/ToolSchema 语义等价证明；因此不能将原 04 的完整 M2 Gate 判定为全绿。

## 12. M3 实测契约覆盖（2026-10-22）

实际命令、完整日志与未准出项见 [m3/RESULTS.md](./m3/RESULTS.md)。

### 已验证

| 关联测试 | 实际验证 | 结果 |
| --- | --- | --- |
| T-04 / INV-01（部分） | 真实 Preact 首帧后 View/Ref/ViewTypeTool 注册齐全；Ref-only 和 Tool-only 不改变 DOM 时推进 epoch | 通过 |
| T-04 / INV-01（部分） | 一个 State 更新中两个 Ref 与 Tool 状态同步变化，观察者无混合状态 | 通过 |
| T-04/T-14 | 40 次挂载/卸载、数据重排、空列表、Tool enabled 变化的状态通知边界 | 通过 |
| T-04/T-14 | 20 次紧密连续更新经 Preact 批处理后只观察最终 Ref/Tool 版本 | 通过 |
| T-05 | View ID 复用仍有新 generation；DOM Node 原位更换 SDK generation 时生效 | 通过 |
| T-07 | Tool 在 Root 声明，目标为 FileDetail；过期 declaration owner generation 被 Core 拒绝 | 通过 |
| T-15（已知标记） | Typed list/item Marker 有匹配 Ref Registry；更换 Type、删项、重排、清空后的旧别名撤销 | 通过 |
| T-06（只读来源） | 真 Worker + 真 SDK + Shadow Core：旧快照 Typed Ref=A、新快照同名 Ref=B、历史 A 不改变 | 通过 |
| M3 默认兼容 | Shadow 关闭时，真实 Worker legacy Ref IndexMap A→B 无 DOM 内容变化也刷新 | 通过 |
| 编译及旧用例回归 | Runtime build/tsc 0，SDK tsc 0，Runtime 452 passed，SDK 72 passed，IDE 5 passed | 通过 |

### M3 新增的非回归要求

- **T-04** 应加入异常渲染、嵌套状态更新、异步回调与 SDK Third-party Hook 时序；未完成前 INV-01 不应标记完全证明。
- **T-15** 应从已知 SDK marker 映射扩展到解析/识别、代码示例中的伪链接/转义、无绑定 Marker 必须拒绝；不能直接以增加 Registry alias 代替词法验证。
- **T-07** 应增加 Tool Owner 重挂载、ViewType 对象不存在时的可见性与 Schema 精确性对比，并覆盖 IDE Root 注册 FileDetail Tool 真实工作流。
- **T-13** 必须压测 100/1000/10000 条 useArrayRef Items 与 typed/bare alias 数据大小，对大列表的复制/Ref 限额设置被批准的预算，不能凭空估计性能改善。
- **T-12** 的 IDE 真实多文件、LSP、文件变更及错误恢复尚未完成，当前 5 项 Jest 只能代表存量单测。
- **T-06/T-08/T-11** 的旧 Ref 活态执行、ToolResult 业务失败真实传播、Strict 与 legacy 安全切换，仍属原始 P0 待修事项。

**测试结论**：M3 核心切片的指定回归与跨 Worker 测试真实通过；完整 Strict Snapshot Gate 仍未准出，不能以局部完成替代未执行测试。
## 13. 方案 B 的 View-owned Tool 纯 Core 合同（2026-10-22）

[执行报告](./m4-preflight/RESULTS.md) · [覆盖率](./m4-preflight/core-coverage.log) · [完整回归](./m4-preflight/final-regression.log)。

当前 Stage 0 已新增 19 个纯 Core 测试，核实：

- 不同 AppInstance 与同名 View 卸载重挂载不重用 viewInstanceId；重复当前 viewId 拒绝；陈旧 unmount/release 不能注销新 View。
- 两个乃至 80 个 FileDetail 自治注册同名 Tool，分别持有 Handler，Runtime 只输出一条按类型聚合的公开 Tool 定义；不同 ViewType 同名工具不冲突。
- 同组 description/Schema/isMutating 必须一致；不一致失败且不部分注册；Schema 属性顺序差异不影响相等判断。
- disabled 影响本 View 实例；重新启用/重新注册使旧内部 Tool 绑定版本失效；旧快照目标不能通过当前 viewId 猜测或重定向。
- 业务 success:false 原样传播；异常及非法结果明确失败；Handler 不进入公开描述；JSON Schema 经严格深拷贝和冻结且不执行 getter；in-flight View 关闭后不改写为其他实例。
- 新 Core 97.02% 语句、91.95% 分支、100% 函数覆盖；Runtime 471、SDK 72、IDE 5 测试通过（全量回归原始日志在上方）。

**仍未验证**：SDK/Worker 的真实 View-local Tool 注册 API、正式 Snapshot 的目标绑定数据、Pinned Snapshot 授权、实际 IDE Tool Handler 文件操作、业务 CAS 和旧 ToolResult 正式通道修复。Stage 0 合同测试不能代替 M4 执行链验收。


## 14. M4 Stage 1/2 的可复现实测合同（2026-10-22）

[Stage 1 实施报告](./m4-preflight/STAGE1_RESULTS.md) · [Stage 2 实施报告](./m4-preflight/STAGE2_RESULTS.md) · [最终 Stage 2 全套测试](./m4-preflight/stage2-final-regression.log)。

| 维度 | 已实测 | 仍未证明 |
| --- | --- | --- |
| SDK / View-owned | 12 项真实 Preact 测试；双 View 同名工具、60 步挂卸载、同一 App 关开、Schema 冲突回滚、新旧 API 同时使用 | 真实 IDE 全部 Tool Handler 新签名迁移 |
| V1 兼容 | Stage 2 V1 与 V2 并存，M1 老测试回归 | 混合 Root/Local App 对 V2 目标的完整 parity |
| V2 Source | 14 项 V2 合同测试；旧 fd_0 与新同名 View 不误绑定、Tool-only 改变 Revision、重复/伪造目标拒绝、非 JSON/getter/容量限制 | 不受控异步业务对象修改、第三方 Hook 的真正提交屏障 |
| 可信目标选择 | 10 项 Store Lease + 最新 App 状态 + bindingVersion + Schema 选择；历史 TTL、App 重启、V1 回退与 degraded/stopped 均拒绝 | 活态 Handler 的业务授权与 CAS、执行中卸载/取消 |
| 真 Worker | V2 真实 App Ref A→B、Tool-only Schema 更新、同名 fd_0 重挂载；连续 4 次 E2E 通过；V1 Legacy Agent Tool 路径保持原状 | 真实 IDE 文件操作/LSP 端到端、生产 p95/内存 |
| 全量测试 | Runtime 497 passed / 3 skipped / 7 todo；SDK 84 passed；IDE Jest 5 passed；Runtime/SDK/IDE TypeScript exit 0 | Model Provider、不同 Host 路径的独立正式执行证明 |
| 资源 | Node23 synthetic V1/V2 100 Views p50=5.298/10.974ms；V2 validator/source selector 两新文件 coverage 94.71% lines、85.58% branches、100% functions | IDE 性能预算、极大 ToolTarget 集合的内存和时间 SLA |

不要将纯 Core 的来源选择测试当作真实业务 Tool 的权限验证；执行 Stage 3 后还要验证 ToolResult 业务失败没有被外层包装为成功。


## 15. Stage 4 默认路径故障与来源时序回归（2026-10-23）

[完整回归](./m4/stage4/final-regression.log) · [Stage 4 实证](./m4/stage4/RESULTS.md)。

| 类别 | 真实测试与结果 | 仍未证明 |
| --- | --- | --- |
| Worker Source / Timestamp | 两个同毫秒合法 Fragment 均接收、可与 Shadow 配对；伪造 appId/instanceId 和显式重复/递减 captureSeq 拒绝 | 无实例字段的旧外部 Worker 不具备额外来源认证 |
| ToolResult | 非布尔 success 不能包装成功；旧 raw Handler 兼容；业务 success:false 仍沿 Host/Agent 返回失败 | 全部第三方 Tool Handler 的逻辑真实性 |
| IDE ViewIdentity | create_file 不再推测新文件的 fd 编号，后续 Snapshot 才声明实际身份 | 真 IDE 多文件/LSP 全流程时序 |
| OS 原子创建 | 真实临时目录：已存在的文件不改写，8 次并发同路径仅 1 次成功，原内容完整 | write_file/edit_file/rename_file 资源 CAS 与跨进程事务 |
| 部分失败结果 | 文件已经创建后 UI/事件/持久化失败会返回成功和具体 warnings；真正磁盘创建失败无后续副作用 | UI 与文件系统跨资源事务 |
| Snapshot 性能 | V1/V2 24 个 Core 安全合同持续通过；V2 的内部可信代理免重复复制；3 次合成 100 View benchmark | 真实 IDE CPU、内存、p95 预算 |

最终回归：Runtime 509 passed / 3 skipped / 7 todo、SDK 84 passed、IDE Jest 14 passed；Runtime/SDK/IDE TypeScript exit 0。V2/source-binding 两文件 scoped coverage 94.71% lines / 85.58% branches；IDE 两个 Workflow/ViewID 文件 100% lines / 88.88% branches。Jest 初次把整个未测试的大型 filesystem service 包含到 global 80% threshold 导致覆盖率汇总失败，改为相关文件的 scoped coverage 后 exit 0；不能错误宣布文件系统模块整体覆盖率达到阈值。

**剩余 Gate：正式 Mutating Tool 的来源版本+业务 CAS+角色权限+真实 IDE 工作负载，未完成，Strict No-Go。**


## 16. Stage 5：文件版本来源与实际磁盘写入的联合合同（2026-10-23）

[全部原始日志与报告](./m4/stage5/RESULTS.md) · [全量回归](./m4/stage5/final-regression.log)。

| Gate | 实测范围 | 结论 |
| --- | --- | --- |
| Runtime/Source | 7 新 V2 EntityRef/Lease/Tool 版本/源 View/实体版本拒绝合同；不向 Tool 返回 Handler | PASS |
| SDK | 2 新实体 Ref Hook 测试：版本独立变化推进 Epoch，缺失版本拒绝 | PASS |
| Worker Producer | 3 新测试：实体标记与普通 Ref 区分，恶意 getter/多余字段拒绝 | PASS |
| 真 Worker + V2 | 实际 SDK 与 IPC 产生实体 Ref；历史 A→B 的来源失效；新增真实临时文件写入联合 E2E 1 个 | PASS |
| IDE FS | 11 项实际临时文件验证：版本冲突、8 并发仅一成功、workspace 范围、symlink/hardlink、文件消失、非 UTF8、大小、独占锁 | PASS（合作式） |
| 端到端连通 | 5 个 Source Store + 真实 FS 连接测试，旧快照/重放/外部修改全部拒绝 | PASS |
| 稳定性 | 4 轮各 7 项 Runtime E2E + 11 项 IDE 真实文件系统测试，无间歇失败 | PASS |
| 全量 TypeScript 与回归 | Runtime 525、SDK 86、IDE 25 全通过 | PASS |
| 定向覆盖率 | Runtime source-binding 95.38% statements、92.72% branches；SDK useRef.ts 100%；IDE versioned-file-write 93.22% statements、82.35% branches | PASS（指定文件而非全仓） |
| 真实 IDE/LSP 与独立外部文件写入者 | 正式 Agent、授权资源版本 CAS 与完整编辑/删除实测尚缺 | NO-GO |

需特别注意：即使版本来源 Snapshot 有效，磁盘文件可能在调用期间独立改变；资源适配器必须在真实执行处再次比较。Node wx 锁不能强制外部所有进程参与，不能以测试中的合作式写入证明无条件原子 CAS。正式 Mutating Tool、异步长事务/租约过期与全产品并发仍未准出。
