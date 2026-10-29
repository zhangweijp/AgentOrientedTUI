# RCSC-02 — 影响面评估与兼容性矩阵

- **状态**：Draft / 供 03 技术设计和 04 开发计划引用
- **代码基线**：本地 HEAD 789ef07 + 未提交更改（2026-10-21），只检视 TS/TSX 源码及测试
- **评估范围**：正式 Runtime、SDK、IDE App；实验目录仅验证可行性，不作为产品路径
- **语义命名**：App / View / Ref / Tool；SDK 工具 API 为 ViewTypeTool。历史文件的 Operation 名称只用于指示迁移入口。

## 1. 影响等级定义

- **P0 / Correctness**：不修将破坏 INV-01～12，可能产生错误对象执行、错误成功或损坏快照。
- **P1 / Protocol**：跨 Worker、Runtime、SDK 的协议及行为迁移，需兼容适配。
- **P2 / DX & Optimization**：开发者体验、性能、包边界；不应成为 P0 上线阻塞，除非造成正确性或严重回归。
- **风险标签**：H = 高（需 Spike+回退）；M = 中（需双轨对比）；L = 低（纯内部变更）。

## 2. Runtime Core / IPC 逐文件影响

| 代码位置 | 当前代码职责 | 计划变更 | 风险 / 里程碑 |
| --- | --- | --- | --- |
| runtime/src/spi/core/snapshot.ts | CachedSnapshot、StructuredSnapshot、IndexMap 相关类型 | 新增 AppSnapshot/WorkspaceSnapshot/RefDescriptor/ToolDescriptor/健康态；旧类型过渡 | M / M1、M5 |
| runtime/src/spi/runtime/snapshot.interface.ts | Worker Fragment、格式化契约 | 新增 SnapshotProducer/PreparedDraft 所需端口，避免 HTML/DOM 类型泄漏 | M / M1 |
| runtime/src/spi/worker-protocol/messages.ts | SNAPSHOT_FRAGMENT（timestamp、markup、indexMap、views、version?） | 新增 SNAPSHOT_PREPARED 协议（instanceId、producerSeq、sourceEpoch、draft、schemaVersion）；老消息 flag 兼容 | H / M2 |
| runtime/src/worker-runtime/index.ts | DOM observe、pushSnapshotFragment、动态导入 App、IPC | 将 DOM 转换委托 Producer；投影就绪屏障；拷贝 Draft；错误上报；不得自己宣告权威 revision | H / M2/M3 |
| runtime/src/worker-runtime/view-fragment-extractor.ts | DOM data-view-id / fragment digest/timestamp | 保留为 DOM Producer 内部适配；结果转结构化 ViewSnapshot | M / M2 |
| runtime/src/worker-runtime/app-kernel/AppKernel.ts | View/Ref/typeTools 活态注册、工具执行、ref 解析 | 暴露一致捕获端口，Registry mutationEpoch；Ref/Tool descriptor 导出；移除模糊后缀绑定；修正 Tool result | H / M2～M4 |
| runtime/src/engine/app/worker-host.ts | 缓存 Fragment，按毫秒 timestamp > 判断 | 新协议校验 instanceId/producerSeq，提交后更新缓存/触发信号；丢弃旧实例包 | H / M2 |
| runtime/src/engine/app/worker-sandbox.ts | Worker 与池/生命周期 | 创建/传递 appInstanceId；销毁/复用隔离，旧 pending snapshot 失效 | M / M2 |
| runtime/src/engine/app/manager.ts | App 安装、更新回调、Worker 生命周期 | 映射实例 token 与健康态；发布失败信号不能宣称成功更新 | M / M2/M5 |
| runtime/src/engine/core/desktop.ts | 收集 Worker Fragment、Desk 生命周期 | 读取各 App 已提交指针，组合 Workspace revision vector | M / M4 |
| runtime/src/kernel/index.ts | acquireSnapshot 每次 format + create Registry | 读已提交快照/组合视图；维持兼容 facade、失效与安全执行 | H / M4/M5 |
| runtime/src/engine/system/registry.ts | TTL/refCount 的 SnapshotRegistry | 新 Store latest pointer + bounded history/lease；旧 API 过渡 | H / M1/M4/M5 |
| runtime/src/engine/view/snapshot/formatter.ts | 聚合 Markup、IndexMap，冲突时改 Tool key | 改为从结构化 View/Ref/Tool 生成兼容投影；禁止 Core 自动改内部 Tool 身份 | H / M4 |
| runtime/src/engine/system/dispatcher.ts | 根据 snapshotId 尝试解析 string refs | 迁移为明确 ToolInvocation、统一 SnapshotRefResolver；普通字符串不自动提升 Ref | H / M4 |
| runtime/src/facades/facades.ts | createRuntime 初始化 Kernel | 注入 Committer、Store、Producer 注册端口，保持默认零配置 | L/M / M4 |

**推荐新增内部目录（不代表立即拆 npm 包）**：
- runtime/src/core/snapshot/：types、validate、clone、commit、store、read、health。
- runtime/src/core/tool/：ToolDescriptor 与绑定验证接口（仅 Snapshot 所需子集）。
- runtime/src/producer/dom/：现有 DOM Transformer / Fragment adapter 的迁移壳；可先通过桥接引用旧文件。
- runtime/src/core/ports/：SnapshotProducer 与读取执行端口。

## 3. SDK 影响与对开发者的公开兼容承诺

| SDK 位置 | 当前机制 | 本阶段改动 | 兼容要求 |
| --- | --- | --- | --- |
| sdk/src/components/View.tsx | useLayoutEffect 注册 View；data-view-* 输出 DOM | 增加稳定 identity + projection epoch / lifecycle 通知 | createTUIApp / View 写法不强制变化 |
| sdk/src/hooks/useRef.ts | useEffect 注册，Markdown Ref marker | 经过 ProjectionCoordinator 确认注册与当前 Render 匹配 | useDataRef 调用方式保持；默认严格输出需 Codec 策略 |
| sdk/src/hooks/useArrayRef.ts | useLayoutEffect 注册 index ref | Ref Descriptor 身份显式作用域；数组下标仅为快照局部别名 | 同 API 可继续，但不能宣称跨版稳定 |
| sdk/src/hooks/useViewTypeTool.ts | useEffect register/unregister；enabled 动态化 | ToolDescriptor 结构化注册及 flush-ready；Handler 单独存储 | useViewTypeTool/defineParams 外部参数保持 |
| sdk/src/contexts/index.ts | 向 Hooks 注入 registry/context | 增加协调 Port、反向依赖收敛 | 不需要业务开发者自行 new Registry |
| sdk/src/app-factory/createTUIApp.ts | HTMLElement + Preact render，传运行上下文 | 将 Producer 适配配置内部化；对外保留 Factory | 不强制重写现有 App |
| sdk/src/adapter/createInlineView.ts | IView 壳复用 DOM 容器 | 保留兼容层，逐步减少 Core 对 HTMLElement 读取依赖 | 旧组件模式正常运行 |
| sdk/src/utils/validateArgs.ts | 参数验证 | 与 ToolDescriptor Schema 的单一来源对齐 | 禁止两个不同参数 Schema 相互矛盾 |

SDK 公开承诺是**本阶段不强制变更现有调用形态**，不是承诺任何未定义行为或错误 Ref 语义永久兼容。严格拒绝非序列化对象时必须给具体错误与替代写法。

## 4. IDE App 的实际行为回归范围

| 用户路径 | 对 Snapshot 的意义 | 风险点 | 必须保持 |
| --- | --- | --- | --- |
| 初次启动、无 Workspace | 首次有效提交、不捏造 ready | useAppEnv、初次 effect、空数据 | 呈现明确空状态，可添加 Workspace |
| 添加 Workspace | View 与可用 ViewTypeTool 同时变化 | enabled useEffect 可能晚于 DOM | 新快照 Tool 与 View 一致 |
| 打开文件、多文件 | 动态 FileDetail 挂载/卸载 | fd_0/fd_1 按数组位置生成，旧 ID 可变 | 旧快照绑定不能指向错误新文件 |
| 修改文件并发 file_changed | FileContent/LSP 异步刷新 | 中间 loading 与最终内容跨多次提交 | 每次发布都是合法一致状态 |
| 搜索文件和搜索结果 View | 结果列表/条件 Tool 切换 | SearchResult 重建与 Tool enable | Ref/Tool 结构不混淆 |
| 关闭/重开文件 | View Instance 生命周期世代 | 旧 View ID 被复用 | 老绑定被撤销，不可复活 |
| LSP 故障或耗时查询 | 业务事实变化与可观察状态 | 不应等待 LSP 永远完成才可提交 | loading/error/success 都能被明确投影 |
| App 关闭/Worker 重建 | instanceId 跨世代 | 旧 IPC 晚到、Registry 泄漏 | 旧 Snapshot 不能执行新 App 的 Handler |

**重要限定**：IDE 大量 Tool 直接使用 filePath / view_id 字符串；现有 IDE 并非稳定 Ref 体系的完整覆盖样本。必须另外增加无 DOM 的纯内存参考 App，验证 Ref 重排、同名冲突、来源快照绑定。

## 5. 代码实验的影响判断

experiments/semantic-kernel/src/contracts.ts、kernel.ts、task-app.ts、test/kernel.test.ts 是独立实验。

**可复用思路**：防 getter/循环引用的值复制、稳定 owner token、不可变观察身份、按来源绑定、entity revision CAS、执行回执、撤销、故障注入与属性测试。

**不能直接迁入**：Action/Observation 术语、Session API、依赖具体模型/MCP Adapter、按需 observe() 的语义；它不等价于正式 ViewTypeTool 注册路径，也没有跨 Worker 的 Core Committer。

处理策略：可复制最小纯算法及契约测试理念，禁止业务层面的大规模重构作为本期依赖。

## 6. 公共 API、Wire API 与持久化兼容面

| 边界 | 承诺 | 版本策略 |
| --- | --- | --- |
| SDK Public API | 第一阶段对 createTUIApp/View/useDataRef/useArrayRef/useViewTypeTool 源码兼容 | 测试驱动，如必须破坏需另出 Migration ADR |
| Runtime Public Snapshot API | 旧 acquireSnapshot/releaseSnapshot 提供限期兼容壳；新 readLatest/getById/lease 为真实语义 | 阶段 M4 切换，M5 清理 |
| Worker IPC | 版本号明确；新旧消息不可用 timestamp 混判 | feature flag 控制 strict path；旧实例消息拒绝 |
| IndexMap | 只保留 legacy 读取投影，不作为新 Ref/Tool 真相 | 编译生成、不可逆写入，不双向修改 |
| App 持久化 | 本阶段不更改 IDE/SDK 数据库格式 | 无数据迁移需求；Source Snapshot Store 默认内存 |
| Tool 执行结果 | 不再将业务失败包装成功 | 契约修复，需回归所有调用方 |

## 7. 风险及回退矩阵

| 风险 | 检测 | 回退方式（不重写业务状态） |
| --- | --- | --- |
| SDK ProjectionBarrier 无法判断 ready | SP-01/SP-02、Ghost Ref 测试 | 保持 shadow 模式，不开放 strict |
| Ref payload 不能序列化 | shadow metrics / codec error | 仅用旧路径对比诊断，按兼容计划添加 Codec；不暗中 live pointer fallback |
| Tool/Ref 双轨出现差异 | 旧 IndexMap 与 Draft diff 结构化报告 | 关闭严格对外开关，保留新代码用于影子校验 |
| Worker 旧消息重放 | instanceId/seq 验证与故障注入 | 丢弃消息、应用标记 unready/degraded、重新同步完整 Draft |
| 新 Store 额外内存过高 | bytes/retained/count 监控与基线 | 降低历史预算、保留 lastGood 和安全当前观察，不退回错误解析 |
| 外部修改导致老状态 | Source invalidation 与写时版本检查 | Tool 拒绝并要求重新观察，不根据旧 View 自动推断新对象 |

**回退禁令**：不可在发生 Strict Ref 解析失败之后，静默回退到旧活态 RefRegistry 并继续执行写入 Tool。回退只能切换整个受测试的执行路径，并需阻止跨路径复用来源 SnapshotId。

## 8. 明确不在本轮修改的域

- 不修改业务 App 的文件/数据库模型，不把所有业务写入纳入 Runtime 统一 Store。
- 不替换 Node Worker 或 Preact，不修改模型调用/编排实现。
- 不引入跨 App 事务、全局安全沙箱、远程分布式一致性协议。
- 不优化 DOM Diff / KV Cache 或对外工具发布格式，除非为保证 INV-01～12 必须修复的兼容问题。

## 9. 影响面准出要求

M0 必须输出：源文件与测试文件依赖图；Ref/Tool 并发注册时序样本；非 JSON Ref 清单；旧/新 Snapshot 字段差异表；IDE 核心回归路径。

M3/M4 之后必须输出：SDK 不变更示例的可运行证据；IPC restart/reorder/missing-message 故障注入；快照读取/执行端到端检验；可观测 degraded 与 snapshot-expires 行为。

与 [04 开发计划](./04-plan.md) 的每个里程碑对应，并由 [05 测试计划](./05-tests.md) 覆盖高风险边界。

## 10. M0 证据补充：实施影响需提高优先级的具体点

本节只记录本地可运行实验对上文影响矩阵的修订，证据见 [m0/RESULTS.md](./m0/RESULTS.md)。

| 代码位置 | 新发现的实测行为 | 对原计划的影响 |
| --- | --- | --- |
| sdk/src/hooks/useRef.ts + runtime/src/worker-runtime/app-kernel/AppKernel.ts | Ref-only 内容变化可更新 RefRegistry，却不产生 markDirty 或 DOM Mutation | M3-A/B 必须新增 Registry 语义变更通知；仅延长 DOM 节流无效 |
| sdk/src/hooks/useArrayRef.ts | listRef 生成类型化可见链接，但不注册对应 list-level Ref | M3-D/M3-E 必须定义 listRef 是 Tool 可用 Ref 还是展示标记；strict Validator 不得默认猜测 |
| sdk/src/hooks/useViewTypeTool.ts | 初次注册/禁用在被动 Effect 中完成，可能与 DOM 的观察时点不同 | M3 ProjectionCoordinator 必须统筹 Tool/Ref/View 的同一就绪屏障 |
| runtime/src/engine/app/worker-host.ts | 同毫秒 Fragment 被丢弃；使用真实 Worker IPC 可送入不匹配的 appId 消息并被当前接收器接受 | M2-A/B/D 强制校验来源 appId+instanceId+producerSeq；跨实例晚到仍需全链测试 |
| runtime/src/engine/system/registry.ts | 内容相同重复 create 产生不同 ID；保留的 payload 与源对象共享嵌套引用 | M1-B/C/D 的 defensive copy、stable revision 不可删减 |
| runtime/src/worker-runtime/app-kernel/AppKernel.ts | 活态 Ref suffix fallback 可跨 View；旧 Snapshot 值 A 与 Tool 实际选择 B 分裂 | M4-C/D 为 P0 正确性任务，不能作为普通 DX 改善延后 |
| runtime/src/worker-runtime/app-kernel/AppKernel.ts | 业务 Handler 返回失败，外层 success=true | M4-E 的结果语义修复为 P0；可单独提前修复，但要做兼容核查 |

**改造原则**：需要改动 SDK *内部*注册时序与标记语义，但暂不改变 useDataRef/useArrayRef/useViewTypeTool 的公开调用姿势。M0 的同步 Coordinator PoC 不是正式可交付实现；异步副作用、真实 LSP、WorkerPool 重启必须在 M3/M2 的后续测试中补齐。

## 11. M3 新代码的真实兼容与影响面修订（2026-10-22）

完整日志见 [m3/RESULTS.md](./m3/RESULTS.md)。

| 影响范围 | 实际变动与兼容效果 | 后续风险 |
| --- | --- | --- |
| SDK useDataRef | 原 passive useEffect → Layout Effect，首帧 Registry 与 View 一致 | 异步异常与直接修改 mutable object 无通知 |
| SDK useArrayRef | 列表本身与 typed item 都注册同名 Ref；bare ID 仍保留 | Ref alias + 数组值会增加快照 Payload；大列表需预算与 Codec |
| SDK useViewTypeTool | Layout 注册、声明 owner View ID + generation；Handler 外部签名未改 | SDK 参数 Schema 与核心 Tool JSON Schema 等价性未全覆盖 |
| SDK View | SDK 独立挂载 generation token；Context 可访问 | 模块级 generation 在运行实例/渲染重入中的身份策略要继续审查 |
| Runtime AppKernel | View/Ref/Tool 增删更新都会推进语义 Epoch；Root 声明者与 FileDetail Tool 目标分开 | 现有 Ref Resolver 的全局后缀 fallback 仍存在，M4 必须统一 |
| Worker Runtime | 有效 SDK Epoch 可以触发没有 DOM 更新的默认 legacy 和 Shadow；Worker INIT 设置 AppKernel AppID | SourceEpoch/Producer readiness 对所有渲染异常还不具备完全证明 |
| DOM Adapter | 优先读取 SDK owner token 并检查 Tool declaration generation | 正式 Core 仍需 Ref Marker Parser 与 Producer 相同版本提交协议 |
| Core | 纯 TS projection coordinator；M1 Snapshot Core 完整未改 | 未来要防止 DOM/Preact 的实现机制回流 Core |

**向后兼容**：本次没有要求 IDE Tool Handler 改写；原 Ref ID 保留为 alias，用户可见的 Typed Ref 字符串不变。与之相伴的 Alias 增量、运行资源和未定义原地突变的限制，不可以在后续文档中遗漏。

**风险分级**：常规 Ref/Tool 注册时序和可见 Marker Ghost Ref 已有真实代码/测试覆盖；但真正原子 Capture Barrier 与统一来源执行尚未完整交付，所以仍不能关闭原始 P0。

## 12. M4 Stage 1/2 兼容与影响审查（2026-10-22）

见 [Stage 1](./m4-preflight/STAGE1_RESULTS.md) 与 [Stage 2](./m4-preflight/STAGE2_RESULTS.md)。

- SDK 的旧五参数 useViewTypeTool、原 Root 级 Tool IndexMap/Dispatcher/Handler 行为未更改。新 View-local Tool 尚未被 Agent 视作正式可执行能力，防止身份绑定/授权完成前产生错误的 UI/工具承诺。
- AppKernel 和 WorkerHost 在 Shadow OFF 时也能共享 Runtime 发放的 AppInstanceId；View 自己的身份在真实 Preact ref commit 阶段生成，并在卸载时回收。新增只读 Runtime 清单供 V2 Producer 核对 DOM。
- V1 的 Snapshot 合同继续严格拒绝未知字段，不会因为 V2 新增字段而静默修改历史契约。M1 Store 类型升级为显式 V1/V2 union，现有 Client/API 没有从内部 Core 扩展公开工具调用权限。
- V2 只在全部 Tool 都为 View-local 的 Shadow App 上选择。混合旧/新 Tool 目前仍按 V1 Shadow 处理；完整 Tool 类型层级迁移尚需设计和生产验证。
- 新代码主要成本来自额外 ToolTarget 数据和复用 V1 检查引起的双层 clone；100 View synthetic V2 p50 为 10.974ms，真实 IDE CPU/内存和 LSP 并发仍待压测。这个风险属于正式 Strict 准出阻塞项。

不得把“结构合法的 AppSnapshotV2”当作“业务实时状态/权限已经校验”的证明。


## 13. Stage 4 对业务正确性与兼容影响（2026-10-23）

[Stage 4 报告](./m4/stage4/RESULTS.md)。

- 默认 WorkerHost 不再仅因毫秒时间戳相同就丢弃第二条合法 Snapshot；可能增加同毫秒多次有效 UpdateSignal，这是修正数据丢失所需的行为变动，后续 IDE 压测应度量频繁更新成本。
- Legacy Worker 的消息会校验 AppID 和（存在时）Runtime-issued AppInstanceID。旧第三方 Worker 若没有该可选字段仍兼容，但可信来源强度不能等同最新 Worker。
- 原 Root TypeTool 返回带非布尔 success 字段的对象现在被拒绝；普通无 success 字段的 Legacy raw Result 继续兼容。
- IDE create_file 的成功 data 不再提供推测的 view_id；Agent 必须从下一次 Snapshot 得到真实 View 身份。文件创建成功但 UI/持久化出现问题时返回 warnings，可能改变以前的伪失败消息。
- Node wx 排他创建会更准确拒绝并发重名文件，不影响明确用于覆盖的 write_file 旧功能；现存覆盖/编辑的业务版本 CAS 缺口仍是 P0 阻塞。
- Core Snapshot V1 验证逻辑仍以原 copyJson 隔离输入；V2 消除重复复制后历史来源、Schema 验证与限制行为由现有合同测试保持稳定。生产 IDE p95/内存不能依据 synthetic 改善而直接放行。
