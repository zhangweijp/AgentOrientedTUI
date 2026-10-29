# RCSC-01 — Transactional AppSnapshot 可行性分析

- **状态**：Draft / Code-grounded feasibility review
- **依据**：2026-10-21 本地实际 TS/TSX 工作树（HEAD 789ef07 + 未提交改动）；不将当前默认分支或旧 Markdown 当作事实
- **目标**：证明方案 C 既能实现 00 的 INV-01～12，又能保留现有 IDE/SDK 路径
- **关联**：[目标与约束](./00-charter.md) · [技术设计](./03-design.md) · [开发计划](./04-plan.md)

## 1. 当前实现能力盘点（证据与缺口）

| 事实（已读源码） | 已经具备的能力 | 无法据此推定的能力 |
| --- | --- | --- |
| Worker 的 pushSnapshotFragment 在同一函数中生成 markup、refs、type-tools、views，并一次 IPC 传输 | 具备单 App 快照片段收集点；便于适配 Producer | 组件 Effect、注册表变更与 DOM 完成时序尚无统一原子屏障 |
| AppKernel 内有 ViewRegistry、RefRegistry、typeTools | 具有可提取的三个语义索引 | registry 未经版本化，Handler 和值目前是活对象 |
| WorkerHost 缓存最新 SNAPSHOT_FRAGMENT | 已有异步发布与缓存链路 | 以 Date.now timestamp 作去重，不保证所有有效提交都被接收 |
| Kernel.acquireSnapshot() 读取 Desktop Fragments、格式化、Registry.create() | 已有对外快照 API 与 lease 操作 | 每次读取产生新的 ID，无法代表稳定的 App 已提交修订 |
| SnapshotFormatter 合并 indexMap，给 Ref 添加 App 前缀，Tool 使用 tool: 键 | 已有可复用兼容投影 | Ref/Tool 无独立强类型事实源；键冲突会自动重命名 |
| SDK useDataRef 在 useEffect 注册；useArrayRef 在 useLayoutEffect 注册 | SDK 可提供 Ref Hook 与 View 作用域 | 不同注册时序可能出现 Markup/Ref 一次观察中的不一致 |
| SDK useViewTypeTool 在 useEffect 注册，enabled 决定注册状态 | SDK 有 Tool 生命周期信号 | Tool 与组件渲染不是事务性注册关系 |
| AppKernel.onOperation / callTypeTool 走活态 Registry | 现有执行链可复用 | Ref 解析存在与来源 Snapshot 脱离、后缀回退与失败包裹成功问题 |

**现状结论**：方案 C 不需要从零构建运行时。Worker 的单函数快照生成点、AppKernel 三个 Registry、IPC 推送和主线程 SnapshotStore 的雏形均可复用。真正的难点在于跨生命周期一致性、不可变值复制、旧版本执行契约，而不是加字段或移动文件。

## 2. 已存在的代码实验：可借鉴但不可直接移植

仓库 experiments/semantic-kernel 是独立的可执行 TS 实验，不是当前正式 Runtime 的实现；其中类型称 Action/Observation，与本 RFC 的 App/View/Ref/Tool 术语不同。

| 实验中已编码的机制 | 对本 RFC 的价值 | 尚不足以证明 |
| --- | --- | --- |
| copyJson 拒绝 getter、循环引用、非 Plain Object、非法数字，并拷贝且冻结值 | 可复用深拷贝/不可变值的技术思路 | 生产 IDE 里所有 Ref 对象均可直接 JSON 化 |
| Observation 按 sessionId、observationId、TTL 生成，绑定 refId 与执行 binding | 证明按「来源观察」固定身份可行 | 它不具备正式 AppSnapshot 语义提交和同 revision 稳定读取 |
| Target 存 kind/id/revision/data，并由 TaskRepository 做写入前 CAS | 实体版本防 TOCTOU 的可运行示例 | 真实文件系统或外部进程写入具有同等原子 CAS |
| invocationId + fingerprint 缓存执行结果，避免同一请求重复写 | 为副作用安全重试留下证明材料 | 此机制已经在正式 Runtime / SDK 中接线 |
| 订阅清理、View owner token、AbortSignal、失败状态分类 | 能验证取消、撤销、未知副作用边界 | Worker 进程终止后具备持久 exactly-once 保障 |

**实验性判断**：若要复用，仅在提炼最小算法/测试后按本 RFC 重新命名、适配；禁止把完整实验框架当作 Snapshot 重构的必选依赖。特别禁止将其按需 observe() 直接等同于方案 C 的持续已提交 AppSnapshot。

## 3. 分项技术可行性

### F-01 · 冻结不可变值（可行，需兼容性扫描）

- Worker 侧可在提交时将 View 内容、Ref payload、Tool 公开 Schema 深度复制为 JSON-compatible wire 数据。
- TypeScript readonly 不足以冻结 caller-owned object；对 getter、函数、循环依赖、Map/Date/BigInt 必须明确 Codec 或拒绝。
- 不直接冻结开发者原对象，避免污染 App 内的可变状态。
- 极大对象要有 bytes、depth、entries、per-view/per-app 总预算；应先在 shadow 模式统计拒绝率与大小分布。
- **风险**：现有 SDK 允许 T extends object，应用可能注册带方法的对象；严格发布可能破坏兼容。
- **缓解**：M0 在不变更行为的前提下统计类型；M2 支持显式 Serializer/Codec；仅在严格接线准备充分后设置 fail-closed。

### F-02 · App 原子发布（可行，必须定义提交屏障）

- Worker 内 AppKernel 与 Preact Component 共享单线程 JS 执行，适合建立受控的 Prepare/Capture 屏障并发出带 producerSeq 的不可变 Draft；**权威 Revision 分配、校验及最新 Snapshot 指针替换由 Runtime Core Committer/Store 完成**（当前部署在 Runtime 主线程，不属于产品 Host 业务逻辑）。
- 但异步 effect、微任务、DOM mutation callback 的阶段不同；“同一 JS 函数读取”不是严格语义一致性的充分条件。
- 所需桥接：ProjectionCoordinator 跟踪 dirty epoch；在 DOM/SDK 注册与卸载稳定时发出 flush-ready；异步状态按 loading/complete 分别提交。
- 捕获 epoch 与发布前 epoch 不一致必须重试或保留 lastGood；不得推送部分 Draft。
- **最大未知**：现有 useEffect 注册能否提供稳定的 flush-ready 时序。M0 必须通过带延迟 Effect、快速挂卸载和并发注册的探针证实。若不能，M2/M3 要先改 SDK 内部协调而不是降低 INV-01。

### F-03 · 独立 Revision / Instance（低风险，可行）

- 每次创建 App 执行实例生成 instanceId；每个实例局部 successful commitRevision 单调递增。
- 不再使用 Date.now 判定 IPC 新旧；WorkerHost / Committer 先按 instanceId + producerSeq 校验准备消息，只有 Core 成功 Commit 才分配并公布 revision；旧实例的晚到消息必须丢弃。
- 同内容无效刷新不生成新 revision；fingerprint 应覆盖 View、Ref、Tool 的语义，而不只覆盖 markup。
- **风险**：重启、Worker Pool reset 或先收到旧 worker 消息，需要定义独立实例令牌，不能依赖 appId 复用。

### F-04 · 旧 Ref 绑定与活态执行（中高风险，可行）

- ReadSnapshot(snapshotId) 只解析被观察时的 Ref 身份/value，不能用当前列表下标或当前 RefRegistry 搜索替代。
- 对旧快照：旧 Ref 可解出原值/实体身份，但副作用 Tool 必须复核当前业务条件/实体 revision，不能直接向 Handler 注入过期 mutable object。
- 当前 Dispatcher snapshot indexMap 与 Worker 的 resolveTypeToolArgs 活态 Ref Registry 需收敛到一个逻辑 Resolver；旧代码可走适配路径，但只允许一个权威解析结果。
- **风险**：某些 Tool 依赖活对象而不是 JSON payload，需要显式业务 Resolver/EntityKey 迁移；首期可选择严格拒绝未版本化副作用调用，不可静默继续。

### F-05 · ToolDescriptor 与 Handler 解耦（中风险，可行）

- AppSnapshot 只携带 toolId、viewType、description、inputSchema、enabled/availability 等公开可序列化描述，不携带 handler。
- Worker 本地 HandlerRegistry 持有具体函数，执行时先绑定旧版本 Tool ID 再验证当前执行能力。
- IDE 在 RootView 中注册目标属于 FileDetail 的 ViewTypeTool；必须保留“定义注册者”与“工具目标 ViewType”是不同概念，不能简单要求 Tool 的声明组件与目标 View 同类型。
- **风险**：现有 IndexMap 工具名碰撞时由 formatter 自动加后缀；核心契约中必须拒绝内部身份冲突，外部名字可由边缘 Adapter 稳定映射。

### F-06 · Workspace 版本向量（可行，不做跨 App 事务）

- 在 Desktop 层同步读取每个 App 最新已经提交的不可变指针，形成 source vector。
- snapshotId 应唯一标识这一份组合观察，读期间可复用相同 vector 的组合实例；不同 App 之间不保证同一时刻。
- 若某 App unready/degraded，必须在组合读取中显式报告，不得静默把老内容当当前。
- **风险**：App 被删除、重装时 appId 仍相同；vector 需包含 instanceId。

### F-07 · SnapshotStore 生命周期（中风险，可行）

- Store 将 current immutable pointer 与 retained historical snapshots 分开；latest 本身需要持有引用，不可因为一次读取 release 而消失。
- 历史有 TTL、容量、bytes 上限；lease 在有界时限内保护读取，硬截止按 RFC 策略执行并返回确定错误。
- 用 snapshotId 定位旧版本；找不到则 SNAPSHOT_EXPIRED/NOT_FOUND，不自动查最新。
- **风险**：当前 Registry.create() refCount=1、release() 归零即删；新 Store 对旧 API 需双轨适配与限制旧消费端迁移期限。

## 4. 替代路线再评估

| 方案 | 短期可行性 | 是否解决 Core 语义契约 | 决策 |
| --- | --- | --- | --- |
| A：仅强化 SnapshotRegistry | 高 | 否；无法保证源头时序一致 | 可抽用校验/冻结技术，不单独落地 |
| B：读取时临时冻结 Pull Snapshot | 中 | 部分；容易把同步压力转为读取延迟 | 保留为可选 Producer 策略，不做默认 |
| C：App 侧 Draft + Core Commit | 中高，依赖 M0 证据 | 是，且兼容现有 DOM/Worker | **推荐** |
| D：直接语义 IR 重写所有 View | 技术上可行，当前兼容性成本高 | 是，但扩大本轮问题域 | 暂不选，未来 Producer 候选 |

**选择 C 的先决条件**：F-02 的投影屏障在真实 SDK Hook / 多 View 场景下可以通过契约测试证明。若不能，必须先解决注册时序，禁止退化为「末端校验后宣称强一致」的方案 A。

## 5. 预研验证（Spikes；不改变产品代码）

| Spike | 实验输入 | 需要观察/输出 | 通过条件 |
| --- | --- | --- | --- |
| SP-01 | Preact View + useDataRef/useArrayRef/useViewTypeTool，挂载与快速卸载 | 注册时序日志、缺失 Ref/Tool | 能定义稳定 flush-ready；或产出必须改 SDK 的最小清单 |
| SP-02 | 在捕获期间插入状态更新和 Tool enable/disable | mutationEpoch、Draft 废弃次数 | 不发布混合版本；最终发布最新合法版本 |
| SP-03 | JSON、循环引用、Date、Map、Class 实例、超大对象 | 拒绝/Codec/大小诊断 | 不影响源对象，错误路径具体，拒绝不破坏 lastGood |
| SP-04 | 重启 Worker 且延迟到达旧 SNAPSHOT_FRAGMENT | instanceId/revision 序列 | 新实例永不被旧消息覆盖 |
| SP-05 | 两个 View 同名 Ref、列表重排/删除、旧快照再执行 | 原 Ref Identity、执行决策 | 不误指向新对象；冲突被明确拒绝 |
| SP-06 | App snapshotA、B 来自不同提交周期 | Workspace revisionVector | 只聚合完整 App commits，不宣称跨 App 事务 |
| SP-07 | 10/50/100 Views、不同比例文本与 Ref 数据 | commit 时延、峰值内存、拷贝代价 | 得到有置信区间的基线，不预设虚构性能提升 |

## 6. 成本、风险及风险降低手段

### 实施成本预判（相对等级，不是工时承诺）

| 变更域 | 相对成本 | 主要风险 |
| --- | --- | --- |
| 纯 TS Snapshot 类型、Validator、Store | 中 | 兼容数据格式和资源预算 |
| Worker Producer & IPC 升级 | 中 | 旧实例消息、同毫秒变更、首次启动 |
| SDK 注册生命周期屏障 | 高 | Preact effect 次序、重复注册、快速挂载卸载 |
| Ref/Tool 来源绑定与执行强校验 | 高 | 既有工具输入兼容、旧调用路径 |
| Workspace 聚合 + 兼容投影 | 中 | 多 App 版本、旧读取 API |
| E2E、故障注入、性能基线 | 中高 | 真实 IDE、异步 LSP、Worker 资源 |

### 不提前承诺的事项

- 不能基于静态阅读宣称本地测试已通过；测试运行情况见 06 审查日志。
- 不承诺 Snapshot 提交后外部文件系统没有变化，业务写入仍须最后一刻复核。
- 不承诺无限历史保留、跨进程 exactly-once 副作用、跨 App 全局原子。
- 不宣称所有 Ref 都天然具有稳定 Entity Identity；兼容迁移可能要求显式 Locator 或 Codec。

## 7. 决策门槛

- **Go to M1**：SP-01、SP-02 能证明至少存在可实现的可靠提交屏障；SP-03 给出对象兼容清单；所有未证实假设在 03、04 文档中显式列出。
- **Go to strict mode**：INV-01～12 的必需测试通过；兼容适配路径不会静默执行旧 Ref 或造成错误 Tool 成功；旧新快照对比差异已分级处理。
- **No-Go / 停止推广**：Ref 错绑、来源版本混用、Handler 错误被吞、快照受调用方修改、Worker 重启旧消息覆盖等任意正确性回归。

**结论**：方案 C 技术上具备可行路径，现有正式 Runtime 能复用运行链，实验代码能提供测试素材；但最关键的“SDK 注册与渲染原子屏障”尚需实验证明。因此本 RFC 不能将原子提交描述为已实现能力。

## 8. M0 实测附录（2026-10-21）

M0 第一轮代码预研已实际执行，详见 **[m0/RESULTS.md](./m0/RESULTS.md)**，不要将上文「待做 Spikes」误解为尚未开始或全部完成。

核心实证：
- **SP-01**：真实 createTUIApp/View/AppKernel 初始 DOM 与 View 已就绪，但 useDataRef / ViewTypeTool 的 passive-effect 注册尚未完成。Ref-only 值改变在 DOM 和 markDirty 侧均未被通知。
- **SP-02**：不修改产品 SDK 的 layout-effect + 微任务 Coordinator PoC 同步路径成功，构成可能的修复方向；完整异步生命周期仍未证明。
- **SP-03**：扫描 53 个 Demo TS/TSX 文件，发现 12 处 Ref Hook；类型多为 JSON 友好声明，但未证明动态实例的序列化安全，Codec 策略仍待定。
- **SP-04**：实际 Worker Threads 接收测试显示同毫秒第二消息被忽略，且接收端允许不同 appId 消息覆盖缓存；正式 WorkerPool 重启仍待验证。
- **SP-05**：来源 Snapshot Ref=A，而活态 AppKernel 解析得到 B，Type Tool 使用 B；需要来源快照约束与执行时版本复核。
- **SP-06**：正式 SnapshotFormatter 可聚合多 App 片段，但没有组成 App instance/revision vector。
- **SP-07**：已有正式 Transformer/Extractor/Formatter/Registry 组合的局部合成性能基线；不包含 Preact/IPC/真实 IDE/I/O，性能预算不能据此批准。

另复现：现有 callTypeTool 把业务 success=false 包装为外层 success=true，需按照 T-08 修复；useArrayRef 返回的 listRef marker 可能没有对应 list-level Ref 注册项，需确定严格协议语义。

**Go/No-Go**：当前为 **Conditional-Go for M1 Pure Core**；**No-Go for strict Runtime / IDE Tool execution**。SP-04 完整 WorkerPool 重启、SP-03 真实运行时对象采样、SP-07 真实 IDE 工作集测量仍是 M0 收尾项。完整证据、命令、日志及待决问题以 m0/RESULTS.md 为准。

## 9. M3 第一轮可行性证据更新（2026-10-22）

[M3 实际执行报告](./m3/RESULTS.md) 将 SP-01/SP-02 的部分假设提升为真实代码证据：

- 从 M0 观察到的 passive useEffect 不一致，已切换至 View/Ref/ViewTypeTool Layout 提交注册；在真实 SDK/AppKernel 初帧已确认 Ref/Tool 注册齐全。
- SemanticProjectionCoordinator 可通过不依赖 DOM 的 Epoch 捕获语义变化，能在 Ref-only 无 DOM Mutation 的情况下驱动真实 Worker 生成新 Shadow Snapshot，也能刷新默认 legacy Ref IndexMap。
- 40 步挂载/卸载、数组重排与 Tool enable/disable，以及 20 次连续状态更新中，测试均未观察到混合 Ref/Tool 通知。
- SDK View generation 与 Tool declaration owner 已经进入 Shadow Core 描述，历史 Typed Ref A 与新快照 Typed Ref B 在真实 Worker 中不会相互覆盖。
- Typed list/item marker 无注册项的既知缺陷已补全，但 Typed/Bare 别名和集合级 Ref 带来额外拷贝/内存成本。

**仍需强调**：以上证据没有证明任意非受控业务突变、异常 Preact 提交、第三方 Hook、任意大小非 JSON Ref payload 都符合严格语义原子性。M3 strict 的真实性能、Codec、Parser 和错误恢复 Gate 仍是未完成项；技术路线 C 可行性增强不等于实现已全面交付。