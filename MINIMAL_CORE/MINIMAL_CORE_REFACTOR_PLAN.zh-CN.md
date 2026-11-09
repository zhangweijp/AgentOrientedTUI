# AOTUI 最小内核重构：技术方案、影响评估、开发与测试计划

> 状态：设计方案，待实施。编写日期：2026-11-03（Asia/Shanghai）。
> 本文由本轮源码和文档静态核对形成；本轮仅新增本文，没有实施代码重构，没有运行项目测试，也不代表项目所有者已经完成 Semantic / Legacy 退出验收。
> 首要约束：减少重复实现与开发者认知负担，不能削弱核心交互、一致性、身份、授权、调用记录、资源边界、清理和失败反馈行为。
> 2026-11-05 范围修订：项目所有者明确取消 D3 历史消息迁移；不延期、不另包、不计剩余工作、工期或准出条件。保留当前读取、规范化、恢复与 compaction 行为。D1 Source 统一及已经批准的历史加载/续跑修复保持。

## 0. 执行摘要与决策

建议采用“保持行为的内核收敛 + 已确认的 SDK Tool/Ref 合同迁移”两条明确标识的工作线。普通 App 作者围绕 App、View、Tool 工作；Ref 是参数能力，持久化与生命周期按需使用。Runtime 内部仍负责无法交给 App 的正确性保证。

本方案允许删除接口和改变作者代码，但每个接口退出必须同时交付消费者迁移、行为映射与回归证据。接口改名、隐藏类型和减少行数本身都不构成完成。

### 0.1 主计划纳入的减法

1. 合并两套 Scope owner，删除重复身份存储、独立内层 Scope Map、重复时钟与嵌套全量扫描；保留现行逻辑生命周期及容量行为。
2. 将 Observation 的管理状态纳入唯一 owner，保留纯投影/捕获函数；取消独立管理器边界，不新造 ContextManager 或 SessionManager。
3. 内联仅有一个生产消费者的 invocation-ledger 薄包装，保留去重、冲突、过期 tombstone 和结果读取授权语义。
4. 最终 Worker 调用入口使用注册时编译的参数合同；删除同一执行段内重复绑定检查、重复 Schema 编译和 SDK 重复校验。
5. 业务 ToolResult 保持单一事实来源，收拢重复结果归一逻辑；公共结果、IPC 和 Driver 边界需要的表达继续保留。
6. 全部 Driver Source 收敛为现有 getContext 合同，删除分读旁路和全局执行路由后备状态。
7. 依照已确认方向，将 Ref 参数接入 ViewType Tool；完整迁移后删除 useViewSnapshotTool 及独立执行路径。
8. 删除专用 ToolUI 作者层及 Demo 的 UI 回传链，以普通内容保留原有指引和非空 View。
9. 修复 CLI 的 Observation 释放遗漏；迁移失效示例、测试、导出与文档。

### 0.2 对上一轮激进建议的修正

| 上一轮建议 | 本文裁决 | 原因与处理 |
| --- | --- | --- |
| 直接删除公开 Scope 协议 | 本次不直接删除 | 当前 /core 和 Runtime 公开承诺独立 Scope 消费；先合并内部 owner，默认 SDK/Driver 不暴露其概念。完整公开退出须另有等价消费者方案，不能借清理丢掉能力。 |
| 删除 Receipt 去重、重放和账本 | 删除包装，不删除行为 | 同 Scope 同调用 ID 的并发合流、冲突拒绝、结果过期后防重执行、按次读取授权都有现行测试。 |
| 删除 ScopePolicy | 本次保留合同 | 未发现生产自定义调用者，不等于公开授权和投影合同可以失效；保留 project/authorize/canReadReceipt。 |
| 删除历史快照、TTL 和 lease | 本次整体暂缓 | 它们是正式 /core 合同，且具有精确到期、容量和 dispose 行为；直接引用不能自动保留这些语义。 |
| 删除 presentations / timestamp | 本次保留 | 会改变动态区排序、IM 历史恢复、去重和 compaction；已有行为测试。 |
| 删除 ToolUI 并直接删去其内容 | 修正为组件删除、内容迁移 | 原 children 可能包含模型操作指引，纯 ToolUI View 裸删后还可能变成空 View，导致投影失败。 |
| 直接删旧消息格式兼容 | 保留现有行为；历史消息迁移已取消 | 不为格式统一改造 Host/IM 生产者、读取边界或 Driver 转换；持久化数据继续由现有路径恢复。 |

上述保留项承担了实际行为，不属于“可删可不删的冗余”。本轮不通过把保证转交每个 App 来制造更小的 Core，也不为未来可能的需求增加新框架。

### 0.3 明确不包含

- 替换 Preact、TypeBox、Node Worker、模型 SDK或包管理器。
- 新增消息 CRUD 框架、通用任务平台、事务平台、权限引擎、全局预算管理器。
- 将 CLI 提升为默认调用协议，或者实现新的 CLI/原生工具切换实验。
- 新增 View collapse/expand、自动摘要、priority/token budget 等尚未完成合同设计的功能。
- 拆分或发布新的包；本轮保持现有包边界，验证纯 Core 与现有适配层边界。
- 未经归因扩大到整个仓库的无关缺陷修复。

## 1. 基线、证据与工作区保护

### 1.1 基线来源

- 远端项目根目录：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI`。
- 读取时 HEAD：`8938449925ada2f92e072e1c0492af8f2428d14f`。
- 工作区存在大量已修改、已删除和未跟踪文件。本文以当前工作树的 src、类型与当前测试为设计基线，不能将 HEAD、旧 dist 或旧 README 视为现状。
- 已读取根 AGENTS.md 和 `.agents/skills/minimalist/SKILL.md`；本文件位于项目根目录，遵守根 AGENTS.md。
- 当前包版本：Runtime 3.0.0；SDK 0.3.0；Agent Driver 0.3.0；IDE 0.1.2；Host 0.1.1。
- 根 packageManager 指定 pnpm 10.15.1；SDK TypeBox 为 1.4.3。构建、测试命令以各包当前 package.json 为准。

规范依据为 [AGENTS.md](AGENTS.md)、[既定评审决策](deepseek_review.md)、[Core 生命周期与边界](runtime/docs/core-lifetime-and-bounds.md)、[Runtime App 交互](runtime/docs/runtime-app-interaction.md)、[Core 公共入口](runtime/docs/core-public-entry.md)。当前实现与目标合同不一致的地方必须显式标注。

### 1.2 关键文件内容指纹

实施 M0 时重新记录本表；任何差异都应重新阅读相关变更，不能照搬本文的静态结论。

| 文件（相对项目根目录） | SHA-256 |
| --- | --- |
| runtime/src/core/invocation/scoped-interaction.ts | dcbb948bb554565a72b7ad1c67f95e64920f4987133906161fe63e9732b36297 |
| runtime/src/core/invocation/observation-registry.ts | ef064b704616c4cda7405ee01386fcd745592d989204320ff46f3b303c7b9a51 |
| runtime/src/core/snapshot/store.ts | c1e5049be291fcf03c6ef3026a1a88c1d504f79c0f950594480b099bbb3b8a81 |
| runtime/src/core/tool/view-owned-tools.ts | 221eacdd233aed0488da4ea195a683c9dfe8d3b265d10065d25db0a505d12630 |
| runtime/src/adapters/semantic-aotui-driven-source.ts | 0efedcf853d143b11c6e10aaf42d90e47f9991bf3c021f17ca42a11d80b03d41 |
| sdk/src/hooks/useViewTypeTool.ts | b0d5c5dd49c1ccbd580b7e1a3edfbb9061eb8bf61a256f6bfbbb8bdbeaa1a4c3 |
| sdk/src/hooks/useViewSnapshotTool.ts | ae27b857be6914f50f76d657670954b09f76d9774becbb82c913dec41dcf0d35 |
| agent-driver-v2/src/core/agent-driver-v2.ts | f065fbbe7c07ad05948bf72d19b4d45de421f4e6cd26b19079ff6d240acdc20a |
| demo-apps/aotui-ide/src/tui/ScopedIDEApp.tsx | 9549e41bbe239603b3a7d4f17eb8ae513ffa6124febd166a58c3009a3bd618bb |
| deepseek_review.md | 89f192c3b57788e11bd141ad4eb8862f6c7c0e98f1d1df00518418b81523dc76 |

### 1.3 实施前保护

先以当前工作树内容形成可复现的任务基线，记录未跟踪的新实现、包链接、锁文件、Node/pnpm 版本和必要测试条件。不得执行全局 reset、clean、stash 或覆盖用户已有工作。不要把所有脏文件一起提交为本任务变更。

若使用隔离 checkout/worktree，必须带入经过确认的当前任务基线；只从 HEAD 新建 worktree 会遗漏当前大量 Semantic 实现。开发提交只包含本任务负责的文件和迁移。

## 2. 不可破坏的核心行为

下表是验证对象，不是对当前实现已经全部满足的宣称。标有“待专项核验”的条目有静态风险，需先建立失败/通过证据。

| 编号 | 必须保持的行为 | 关键边界 |
| --- | --- | --- |
| C01 | 同一逻辑 View 在当前模型上下文只有一份最新有效内容，关闭后退出动态投影 | 不删除真实用户指令、assistant、tool result 或审计历史 |
| C02 | 同一 App 的 View、Tool、Ref 来自相容的已提交状态 | 不宣称多个 App、多个 Source 的全局事务一致性 |
| C03 | 本轮消息、工具声明和执行路由共同捕获，后续刷新不重绑旧调用 | 捕获后仍执行必要的当前有效性检查 |
| C04 | App 实例身份、View incarnation 和工具激活失效不可被同名对象复活 | 旧 cleanup 不能删除同名后继注册 |
| C05 | 普通 Tool 按 App/ViewType 注册一次；多个同类型 View 共享激活，最后一个关闭后失效 | 只关 a、b 仍打开时，edit_file 类型能力可仍存在；a 的业务有效性由 App 检查 |
| C06 | SDK 已提交 Schema 不做隐式 coercion/default；独立 Core 可信 validator 的显式普通参数转换按现行合同保留 | authorize/execute 使用同一份冻结 effectiveInput；ViewType Tool 不自动固定 filePath、文件版本或打开会话 |
| C07 | Ref 从原捕获来源解析、类型匹配、保持只读；不接受模型对象绕过名称解析 | 不能执行时读取同名最新数据，也不自动提供 RefName.property |
| C08 | 展示资格、调用授权、读取结果授权与业务前提按各自合同生效 | 仅隐藏 Tool 不等于授权；异步等待前后的有效性检查不能随意删除 |
| C09 | 同 Scope 同 invocationId/同完整请求最多进入 handler 一次；不同请求冲突拒绝 | 并发、同步重入、已完成重放、Observation 释放和结果 TTL 到期均覆盖 |
| C10 | 未进入、成功、无副作用失败、部分副作用、未知等事实诚实表达 | Worker 失联/超时不等于未执行；不自动重试不确定写入 |
| C11 | 正常调用的终态在所需投影 flush 之后发出，下一轮可读取已提交变化 | App 未等待的后台业务不在此保证内；投影失败须明确，不冒充新状态 |
| C12 | close/release/dispose 不伪造实际异步工作已经结束 | project/validate/authorize/execute/read 与存储/清理的真实 Promise 必须结算 |
| C13 | 配额、输入边界、零值上限、超限拒绝、已发行身份和保留字节保持合同 | 不以 GC、RSS 偶然下降替代所有权和逻辑边界证据 |
| C14 | owner 生命周期和 opt-in TTL 的精确到期规则保持，失败 clock 不阻止显式清理 | 持有旧对象不等于仍有权使用已到期来源 |
| C15 | 重叠 Context 共享当前约定的 Scope；最后一个 owner 释放后才关闭 | GUI 独立读取不影响 Agent；释放一个 Context 不撤销其他 Context |
| C16 | Driver 保持区域、时间顺序、调用结果邻接、更新去抖和单飞规则 | static → session history → dynamic → active tail；不改变跨 Source 同名工具既有覆盖规则 |
| C17 | 历史会话、compaction、Host/IM 恢复保持消息、ID、timestamp 和 provider 数据 | 保留现有 result/output 与 assistant JSON string 读取、规范化和恢复行为；不实施新的历史迁移 |
| C18 | 一个模型 tool call 只有一个副作用执行拥有者 | MCP 的模型 SDK 自动执行与 Driver 执行重叠为待专项核验风险 |
| C19 | tool result 保存后能驱动下一轮；最终 assistant 不形成自唤醒循环 | Host 已有通知行为；IM 只读工具续轮为待专项核验风险 |
| C20 | 持久化、恢复校验、flush、unmount、dispose 及 close/delete 区别保持 | 文件/LSP/搜索等真实业务资源仍由 App 管理 |
| C21 | 模型可见指引、工具名称/说明/Schema、Ref 描述与页面非空性保持 | ToolUI 组件可以删，不能顺便删掉指引或合法页面 |
| C22 | 纯 Core、DOM Producer、普通 TS Producer 与公开包消费继续可用 | 不把 Node、DOM、LLM 类型倒灌进纯 Core；不能只验证 IDE 一个应用 |

### 2.1 允许的变化

- 私有实现、Map 数量、内部函数和文件组织可以改变。
- 同批迁移的 SDK 作者 API 可以发生明确的不兼容变化；迁移后的行为必须对应 C01–C22。
- 已确认的 Ref 目标能力按新合同测试，不伪称是当前普通 Tool 已具备的能力。
- 经独立复现的核心缺陷可以修复；差异报告必须说明“修复什么”，不能把错误行为固化为等价基线。
- 模型可见的纯展示标记可以在 ToolUI 迁移中变化，但必须保留语义内容，并通过显式允许差异清单和行为验证；其他差异默认阻塞准出。

### 2.2 不允许的简化

- 去掉旧身份检查后只按工具名称查最新 handler。
- 用一次 Context release 替代在途调用实际结算。
- 把多个仍有区别的上限取最小值后声称保持容量语义。
- 将所有错误改成 success:false，丢失是否执行及副作用事实。
- 因生产默认 allow-all 而取消公开授权合同。
- 删除契约测试来使删减后的代码通过，或把改 API 等同于删除原行为要求。

## 3. 目标职责与概念边界

| 层 | 自己拥有的职责 | 不承担的职责 |
| --- | --- | --- |
| App | 业务状态、真实操作、资源权限/版本/前提、展示内容、自己的资源清理 | Scope、消息历史 CRUD、内核绑定和通用参数校验 |
| SDK | App/View/Tool 声明、Ref 发布、Preact 对接、必要作者诊断 | 第二套业务状态框架、工具执行授权平台、文件事务 |
| Runtime/Core | 原子提交、身份/调用/Ref 来源、受管理资源边界、操作事实与生命周期 | 推断业务依赖、自动补偿文件写入、Agent 记忆整理策略 |
| AOTUI Source | 当前 View 的 XML/Markdown 消息、工具描述与同次捕获的 executor | 应用业务规则、历史消息数据库 |
| Agent Driver | Source 捕获、模型调用、唯一工具路由、结果回调、续轮与释放 | Scope 内部结构、文件业务、重复的全局路由状态 |
| Host | 会话持久化、模型配置、Source 控制、存储后端和可信授权配置 | 将宿主专用策略扩张为所有 App 必需机制 |

默认教程只讲 App、View、Tool。Scope 是高级 Host/Core 交互的生命周期边界；Observation 是不可变捕获数据；Binding 是内部调用身份；Receipt 是操作结果的承载合同。它们不再被包装为普通 App 作者必须创建和编排的四套对象。

本次不新增一个 Runtime getContext 包装去复制已有 SemanticAOTUIDrivenSource.getContext。公开低层消费和默认 Driver 适配继续复用同一底层实现。

## 4. Runtime 详细技术方案

### R1. 合并 Scope owner，删除第二套生命周期管理

当前外层 `ScopedInteraction.State` 和内层 `ObservationRegistry.Scope` 都保存同一身份、截止时间与关闭状态，并各自维护 Map。外层 refresh 遍历 State 时又调用会执行全量 sweep 的 checkScope，产生重复扫描。源码见 [scoped-interaction](runtime/src/core/invocation/scoped-interaction.ts) 和 [observation-registry](runtime/src/core/invocation/observation-registry.ts)。

**目标：以现有 State 为唯一资源 owner；Observation 模块保留捕获、投影、grant/binding 验证等函数，不再自行拥有第二份 Scope。**

| 当前内容 | 目标处理 |
| --- | --- |
| 两份 appId / instanceId / Scope 身份 | 一份可信 State；内部函数显式接收该 State 或必要只读字段 |
| 内层独立 scopes Map | 删除；observations/reservations 挂入现有 State |
| 内层 openScope/checkScope/closeScope 的独立资源管理 | 收回唯一 owner；公开 ScopeClient 继续调用唯一实现 |
| 两套 clock 包装与每 Scope 全量 sweep | 一个经校验的时钟、一次刷新遍历；保留异步边界重新验证 |
| grant 捕获、来源检查、Ref 可见性、绑定选择 | 保留为内部函数，不借合并放宽输入 |
| project/read/invoke 真实工作计数 | 首批保留；证明时点等价后才能删重复计数 |
| 公开 inspect / close / whenClosed | 保持行为与返回事实；从唯一 owner 派生原有逻辑视图 |

设计约束：

1. 一个 owner 不等于强行合并所有状态位。观察侧已关闭、正在结算的执行/读取、最终可回收是不同事实，可以在同一 State 中表达。
2. 两套 maxScopes 不能直接取 min：外层 closing State 仍可能占位，内层观察 Scope 在 reservations 清空后已不再计数。保留两个逻辑容量视角及其失败码，从同一数据派生。
3. `projects` 不能直接换成 reservations.size：complete 已转移 reservation 后，observe finally 仍可能有收尾及重入。先保留，后续用顺序证据决定。
4. Observation 持有 source 与 invocation 持有 source 生命周期不同；即使指向同一不可变对象，也不能随意合并预算或提前释放。
5. 显式 close/release 在 clock 抛错或回拨时仍完成清理。异步 project/validate/authorize/read 返回后必须使用当时的有效性，不能沿用调用开始时的 now。
6. 不物理拼接两个大文件来追求少一个文件；验收对象是第二个 owner、Map、时钟和扫描确实退出。

保留当前公开 createScopedInteraction、ScopeClient、ScopePolicy 入口，直接连接新的唯一实现。没有新旧双引擎，也没有一个新的管理器套住旧管理器。

### R2. 内联 ledger 包装，保持调用记录语义

[invocation-ledger](runtime/src/core/invocation/invocation-ledger.ts) 目前只有一个生产消费者。将其内联为 State 的 Map，Entry 自己保存 fingerprint；删除无独立职责的工厂和额外 value 包装。

调用时序必须是：

1. 按现有边界捕获 request，得到规范化完整请求及 fingerprint。
2. 在当前 Scope 的 Map 查 invocationId：同 ID 不同 fingerprint 立即冲突；相同则进入结果读取路径。
3. 新调用先完成现行容量检查并同步插入 Entry；在此之前不能调用用户 validator、authorize 或 execute。
4. 同步占位完成后才调度执行；同 ID 并发和回调重入共享同一执行。
5. 每一个 invoke 调用都有自己的读取授权流程；不能把“执行只一次”误改成“读取授权也只一次”。
6. 结果内容到期后清理内容字节，保留 ID/fingerprint 责任至 Scope 终止；不能删除 Entry 后允许相同请求重执行。
7. 结果生命周期独立于 Observation；已完成结果可按现行合同在 Observation 释放、历史到期或临时 degraded 后读取。

保留当前 read 权限失败/抛错、结果不可读、过期、请求冲突、容量失败的分类及公开字段。本轮不恢复已经移除的 readReceipt 方法、accepted 查询或通用后台任务查询。

### R3. 收拢结果转换，保留边界表达

现有结果在 SDK、Worker terminal、Host ExecutionFact、InvocationOutcome、Receipt 和 Driver 间转换。主目标是同一业务结果只有一个规范化来源和一份字段语义，不能强行把不同边界都压成一个 boolean。

实施顺序：

1. 列出 ToolResult.success/data/error/effects 的生产、校验、复制、映射点，建立字段映射表和当前合法/非法结果夹具。
2. 保留现有 ToolResult 作为 App 事实；进入/未进入 handler、transport unknown 等状态由可信 Runtime 产生。
3. 将重复的字段验证和 effects 解释集中到现有调用终态归一处；SDK 不再为了另一套公共结果类型重新解释业务结果。
4. IPC 序列化仍进行有界捕获；Core/Driver 各自边界仍校验实际需要的结构。共享语法可以复用，跨信任/进程边界的捕获不能跳过。
5. 若调整内部表示，现行公开 InvocationReceipt/InvocationOutcome 的输出由唯一边界函数生成；不在多个中间层重复创建后再拆出同一 BusinessDetails。
6. Driver 只在 Runtime→Driver 边界映射一次；保留业务 error code/message/context、partial 提示及未知结果，不以通用错误替换更具体的原错误。

| 事实 | 归一要求 |
| --- | --- |
| 校验或身份检查拒绝，未进入 handler | 保持 rejected/not-entered，不允许 App 自报该事实 |
| handler 返回成功 | 保留成功与必要 data；投影失败另行反映 |
| App 声明失败且 effects=none | 保留已知失败且无变化 |
| App 声明失败且 effects=partial | 保留部分变化与恢复提示 |
| App 未能确认副作用，或响应无法确定 | 保留 unknown，禁止自动安全重试推断 |
| 结果权限拒绝或内容到期 | 不等同于业务失败，也不能重新执行 |

本组首批保持公共结果形状和现行 IPC 合同；如果彻底删除某个公开包装类型需要改变消费者合同，将其移到单独 API 迁移，不与 owner/时钟/关闭改动同批。

### R4. 唯一最终校验入口

主改位置：[Worker ordinary 调用](runtime/src/worker-runtime/ordinary-invocation-v2.ts)、[ordinary 适配](runtime/src/adapters/ordinary-invocation-v2.ts)、[Tool 注册与调用](runtime/src/core/tool/view-owned-tools.ts)、[SDK wrapper](sdk/src/utils/ordinary-parameter-tool.ts)。

注册阶段编译并保存已提交参数合同。真正进入 handler 的 Runtime 注册表入口，按以下顺序处理：

1. 检查关闭、App 实例、当前工具注册/激活和已观察合同仍相容。
2. 使用已注册 compiled contract 校验实际待执行参数；常规 SDK 普通路径 raw/effective 值不发生隐式转换，独立 Core 的可信 validator 可以按现行合同显式转换。Ref 统一后在同一入口使用编译出的解析计划及 effective 合同。
3. 保持已校验参数和当前可调用注册之间没有新的异步空隙；若确需 await，返回后重新验证。
4. 标记可信进入事实，再调用已提交 handler。
5. 捕获返回或异常并生成唯一终态，执行既有投影 flush 顺序。

可以删：同一个 Worker 内紧邻的重复 binding 检查、每次调用从 wire schema 重新编译、SDK 对同份参数再次校验。

必须留：IPC 有界输入捕获、协议协商/App 实例检查、Host 在授权前理解参数所需的校验、经过异步授权后的 liveness 检查，以及最终 Runtime 校验。不能让任意 App 提供的 invoker factory 自己决定是否验证。

authorize 与 execute 必须共享同一份经验证、冻结的 effectiveInput；不能在最终入口重新拿 rawInput 覆盖已授权输入。现有 Core 测试允许可信 validator 将 `{line:'7',surplus:true}` 显式转换为 `{line:7,defaulted:true}`，该能力继续保留。

同合同 render 更新当前 handler 的现行语义保持；不能把一次捕获解释为永远执行旧 render 的业务闭包。变化的公开合同应使旧 activation/绑定失效。

### R5. 资源与 SnapshotStore

本次保留 SnapshotStore 的历史、getById/acquire、owner/timed lease、TTL、预算和 dispose 合同。直接持有 source 可以减少局部传递，但不能绕过已有 lease 准入、精确到期或 maxActiveLeases 失败边界。

保留有意义的输入深度/节点/字节边界、活动工作上限与关闭报告。删除的只是已消失对象对应的重复管理状态；不将不同资源域预算偷偷合为一个总预算。

本轮不承诺全进程 RSS 恒定。需要证明的是受管理对象与逻辑字节有界，关闭后在真实操作结算时归零；调用者持有的不可变值不在 Core 强制回收范围内。

### R6. CLI 与示例的最小修复

[runtime/src/cli.ts](runtime/src/cli.ts) 的 printCurrentViews 成功 observe 后，打印逻辑必须放入 try/finally，在 finally 释放该 Observation。打印失败也释放；只关闭长存活 Scope 不足以防止中途观察额度累积。

[IDE 本地示例](demo-apps/aotui-ide/examples/local-scoped-ide.mjs) 的纯 views 命令同样释放本次临时 Observation；明确留给后续 invoke 的观察才保留到调用者释放。其旧 tool.targets/grant.targets 按当前 V3 execution/toolBindings 迁移。

本组标为具体缺陷/示例修复，使用小提交。不能通过新增自动过期服务或放大默认观察上限掩盖释放遗漏。

## 5. Agent Driver 与 Source 技术方案

### D1. 唯一 Source 合同

复用现有 DrivenSourceContext，不新造 Context 类。迁移完成后，生产 Source 只提供 getContext，返回 messages、tools、executeTool，以及存在受管理引用时的 release。

Driver 顺序固定：捕获各 Source → 组装本轮 messages/tools/routes → 调用模型 → 顺序路由本轮 tool calls → 持久化/通知 → finally 逆序释放已捕获资源。

删除 collectTools、updateToolMapping、collectMessages 的无 captured 分支、executeToolCalls 的全局 map fallback，以及无生产消费的 getToolSource/toolToSourceMap。保留 collectMessages 中仍有必要的协议整理，不能整段删掉。

| Source | 捕获内容与身份 | 迁移要求 |
| --- | --- | --- |
| AOTUI | 当前 Observation、工具来源和 executor | 保留 Context 共享 Scope、禁用门禁、最新 View、region、timestamp 和 release |
| SystemPrompt | 当前 prompt 内容 | 保留 system/static、timestamp 0、变化通知；旧捕获不被原地修改 |
| Host | 当前 topicId、历史窗口、context_compact 入口 | 闭包固定 topic；topic 切换后旧调用拒绝，不能 compact 新 topic |
| MCP | 本轮 tool 描述和真实 executor、server/client 身份 | 捕获函数，不再从后续可变 toolsCache 查；执行前检查当前禁用状态 |
| Skill | 当前 Source/catalog 的加载入口 | 保留 disabledSkills、诊断和通知；不顺便新增技能正文版本锁定 |
| IM | sessionKey、恢复后的历史、compaction 入口 | 并发捕获等待同一个 history-loading Promise；保留去重、timestamp、triggerAgent:false |

当前 split Source 出错与 atomic Source 出错的影响范围不同。迁移后在各 Source 内保留其受控降级策略：例如 MCP 列表获取失败仍按原规则返回空工具；不能因接口统一使可选来源故障一律阻断整个 Agent，也不能静默丢失必要 AOTUI 状态后继续操作。

### D2. 唯一副作用执行拥有者：MCP 专项

静态链路显示：MCP Tool 含真实 execute；Source 将它交给 Driver；LLMClient 原样传给 streamText；已安装模型 SDK 可执行 tool.execute；Driver 又遍历返回的 toolCalls 执行。当前仅确认代码链路风险，尚未运行复现。

设计规定：模型层只收到需要的工具描述/Schema/模型元数据，不携带能够执行业务副作用的 execute；真实 executor 只保留在本轮捕获的路由闭包。不要通过增加第二个去重器来掩盖两个执行拥有者。

测试必须穿过真实 LLMClient→streamText→Driver，用受控 provider 流产出一个 tool call，用计数 executor 证明恰好一次。只 mock LLMClient.call 会绕过风险点，不能作为验收证据。

普通 Host 与 IM 的 context_compact 等占位 execute 也应随统一路由移除。保留所支持 Tool 的模型元数据；不要通过随意挑选少数字段丢失 provider-specific 合同。

### D3. 历史迁移已取消，仅保留既有行为

- 保留 context-regions 的区域顺序、region 内 timestamp 规则、同 timestamp 的既有顺序，以及 tool-call/result 邻接修复。
- 保留 AOTUI presentations：未改变内容 timestamp 稳定，内容改变/重新启用按当前规则更新时间。
- 保留当前 Driver 跨 Source 同名工具的后者覆盖规则；AOTUI Source 内的冲突拒绝仍按原规则执行。改变规则另立行为决策。
- 项目所有者已取消历史消息迁移，不统一生产格式、不迁移读取边界、不为此删除 Driver 现有转换，也不另排后续工作包。
- 保留现有消息读取、规范化、恢复与 compaction 行为，以及 toolCallId、timestamp、attachments、provider options；取消项不计剩余工作或准出条件。

### D4. 续轮、停机和现有能力缺口

Host 已有工具结果保存后通知机制。IM 的 onToolResult 当前仅保存而未明确通知，存在只读工具不续轮的静态风险；必须通过完整 IM 链路确认，若成立，补齐结果保存成功后的单次通知，避免重复触发。

IM history-loading 当前布尔位不足以保证并发 capture 等待同一次恢复。复用 Source 内一个 loading Promise；恢复失败后应按既有重试/诊断要求处理，不把失败永久缓存为已加载。

保留 Driver 单飞、pending 更新、去抖与 finally release。停止后迟到的模型响应不能再派发业务；已开始操作的结算不能被取消标志伪装成无副作用。

当前 maxSteps 和 toolCallTimeoutMs 有声明但未见实际执行点。本轮不把它们列为已存在保护，也不通过 Promise.race 假装取消实际工作。若要删除空配置或实现真实限制，作为单独公开合同项处理，不夹带进 Source 收敛。

## 6. SDK、Ref 与 ToolUI 的合同迁移

本节属于已确认目标的 API/协议迁移，不能与 R1–R6 的行为保持重构混为一谈。普通 Tool、提交、授权、生命周期、操作结果与业务行为继续遵守 C01–C22；旧 Ref Tool 的实例绑定/只读/单参数限制按已确认目标退出。

### U0. 开工前完成可编译合同，而非发明新框架

[deepseek_review.md](deepseek_review.md) 已确认继续使用 TypeBox inputSchema、保留 Ref、支持多种 Ref 参数并删除 useViewSnapshotTool；helper 签名、序列化 metadata 和部分类型细节尚未完全冻结。必须先用当前 TypeBox 1.4.3 完成最小技术验证。

本方案对待定范围作如下设计选择：RefName 在一个 App 当前提交的上下文中唯一，不跨 App 解析；同一发布者更新同名数据允许，不同发布者冲突拒绝。这个选择应写入同批规范和测试，不将根文档中尚待定的表述伪称为已实现事实。

U0 必须产出：

1. refType/refParam 最终公共签名、TypeBox 正/反类型用例、对象/列表/数组/optional 的组合规则。
2. 一份可序列化 Ref 参数 metadata 语法；单一声明到模型参数、解析计划和 handler 类型/校验的确定映射。
3. 支持的 payload Schema 语法及预算/错误码；不能承诺任意 TypeBox/JSON Schema。
4. 发布、更新、冲突、旧 cleanup、View 卸载与有效旧 Observation 的确定行为。
5. 新 authoring/参数 profile/Worker capability/Snapshot profile 的版本字面值和兼容矩阵。

U0 是实施依赖，不需要重新讨论“保留 Ref、统一 Tool”的方向。未经这组可编译证据，不进入大面积删除旧实现。

### U1. 单一声明派生参数处理

作者只声明一次 inputSchema。内部编译得到：

- 给模型的参数 Schema：Ref 字段为完整名字字符串；对象 Ref 数组为字符串数组。
- 参数解析计划：字段位置、类型标签、对象/列表/逐项解析、可选性和必要 payload 约束。
- 给 handler 的 TypeScript 类型和 effective 输入合同：只读 payload 及原普通参数。

不能仅把 refParam 包装为 Type.String 就认为完成。当前 handler 类型使用 DeepReadonly<Type.Static<S>>；当前 exporter 拒绝任意 Symbol/隐藏 metadata；当前 ordinary 编译器也不支持完整目标的 x-aotui-ref 和数组结构。必须贯通编译、导出和 Runtime 校验。

以下是拟议形状示意，不是当前可用 API，最终签名以 U0 编译结果为准：

```ts
const UserRef = refType('User', UserSchema);
const sendCoupon = defineViewTypeTool({
  viewType: 'Coupon',
  name: 'send_coupon',
  description: '向引用的用户发券。',
  inputSchema: Type.Object({
    user: refParam(UserRef),
    amount: Type.Number(),
  }),
  async execute({ user, amount }) {
    // 模型提交 RefName；handler 接收只读 User。
    // App 检查用户当前状态、权限和重复发券等业务前提。
    return applicationSendCoupon(user, amount);
  },
});
```

不新增 toolInput，不让作者同时维护 rawSchema/effectiveSchema，不增加全局业务类型注册中心。

### U2. 必须完整覆盖的参数矩阵

| 形状 | 模型输入 | handler 输入 | 关键拒绝规则 |
| --- | --- | --- | --- |
| 单对象 Ref | 一个名字字符串 | 只读对象 | 不存在、不可见、类型不符、非对象拒绝 |
| 单列表 Ref | 一个列表名字字符串 | 只读对象数组 | 对象/列表不匹配、元素合同错误拒绝 |
| 对象 Ref 数组 | 多个名字字符串 | 逐项解析后的只读对象数组 | 任一无效则整体失败，不跳过坏项 |
| optional Ref | 缺省或合法名字 | 缺省或 payload | 已提供但解析失败不能当作缺省 |
| 多个 Ref 字段 | 各字段按自身声明形状提交 | 各自的 payload | 所有字段准备完成后才进入授权/handler |
| 普通字段与 Ref 混合 | 普通 JSON + 名字 | 普通值 + payload | 普通字符串不被猜测为 Ref，默认值/额外字段保持现行语义 |

基本 optional 组合应覆盖对象、列表和 Ref 数组。总输入预算按展开后的实际参数计算，重复引用同一个大 payload 也不能绕过总量限制。

### U3. Ref 发布、身份与不可变来源

1. 沿用现有发布端口和 AppKernel 注册记录，保存发布者 token、View 身份和类型信息；不新建 RefManager。
2. 对外名字是完整 App 内 RefName；内部仍保留 View ownership，用于可见性、当前发布清理和来源证据。
3. 不同发布者同名冲突报 REF_DUPLICATE；不覆盖、不自动加前缀、不猜测调用者意图。
4. 同发布者再次发布是更新；迟到 cleanup 必须验证 token，不能删除同名后继发布。
5. 只从绑定的有效 Observation 取原值，不能从最新 AppKernel Map 取值。View 卸载会移除当前发布，但已捕获数据按有效 Observation 合同仍可解析。
6. 有效旧 Ref 数据可解析，不代表旧 App/工具身份仍可执行。新 ViewType Tool 必须通过当前 activation、App instance 和授权；业务对象是否仍能操作由 App/Host 判断。
7. 名字不 trim、不自动剥除类型前缀、不执行 RefName.property，也不把 messages[0] 解释为表达式；它可以是完整名字。
8. 目标展示格式为 `(DataDesc)[DataType:RefName]`；Tool 实参仅提交完整 RefName，不提交整个展示表达式。旧 formatter 到新格式的变化属于明确的迁移差异。
9. 类型标签经 SDK→发布端口→AppKernel→Producer→Snapshot→Observation→参数准备完整传递，不只改变 formatter。

当前 AppKernel 使用 View+Ref 组合键且 unregister 按名字删除，Producer 类型值也尚未贯通。不能仅修改 Map key。新命名范围与旧 View-instance Tool 的范围变化必须在迁移清单中显式说明。

### U4. 类型、参数身份与校验

泛型中的 TypeScript 类型在运行时消失；descriptor 的可序列化标签和必要 metadata 仍然存在。泛型形式只支持标签、基础 JSON 与预算检查，不虚构完整业务 Schema 校验。带 Schema 的 payload 在进入不可变 Snapshot 时校验；相同已验证值不必每次执行再次做同一全量校验，消费方约束不同则额外验证。

完整 Ref metadata 必须进入工具规范化合同身份：User→Order、对象→列表、列表→逐项数组、消费约束改变，即使模型侧仍是 string，也必须使旧合同不能错误复用新 handler。不得仅对去除 metadata 后的模型 Schema 计算 fingerprint。

授权所见的 effective 参数与实际执行语义必须相同，不允许授权回调改写参数。Worker 仍负责注册合同的最终执行边界；Host 的授权前解析与 Worker 的最终验证不是可随意删除的重复。

### U5. 协议与兼容矩阵

当前合同包括 authoring `view-type-tools-v1`，interaction `ordinary-v2/snapshot-value-v2`，Worker capability `view-tool-ordinary-invoke/v3` 和 `view-tool-ref-invoke/v3`，以及 `VIEW_TOOL_INVOKE_V3`。旧普通 Tool 使用 view-type+args，旧 Ref Tool 使用 view-instance+rawArgs/effectiveArgs/refSources。

统一参数能力和 Ref 名字含义改变时，必须通过现有 INIT/能力确认机制引入明确的新 revision/profile。U0 固定全部字面值后，只实现一条目标执行链；旧组合拒绝，不能按字段猜测降级。若 Snapshot 中 Ref 索引语义变化，必须有所有消费者检查的新 Snapshot revision 或显式 profile。

| 组合 | 目标行为 |
| --- | --- |
| 新 SDK + 新 Runtime + 新 Worker | 普通和 Ref 参数完整成功 |
| 新 SDK + 旧 Runtime | 初始化/注册时明确 unsupported；handler 零进入 |
| 新 Host + 旧 Worker / 旧 Host + 新 Worker | 握手拒绝，不回退到旧 Ref/ordinary 解释 |
| 旧 App 包 + 目标新 Runtime | 明确版本诊断，要求迁移/重建，不猜测执行 |
| capability/profile 缺失或畸形 | 失败关闭，无副作用 |
| persistence/lifecycle 合同未改变 | 保持其现有协议与行为，不为统一 Tool 增加重复协商 |

这是协调的破坏性 API/协议发布，必须包含仓内全部消费者和包消费验证。R1–R6 行为保持批次可以先独立交付，不依赖本节发布。

### U6. ToolUI 删除与作者迁移

目标：useViewTypeTool(definition, options) 只注册，返回 void；删除 ViewTypeToolUI、ViewTypeToolUIProps、UseViewTypeToolResult 及专用组件生成。使用已有 definition 的名字/说明和必要 App 文案渲染普通内容，不新建 ToolLabel/ToolCatalog 框架。

IDE 删除 UI Context/Provider、receiveUI state/effect、ToolRef；保留注册子组件以满足 Hook 调用规则。WorkspaceCreateView 移除 CreateTool prop 并保留创建文件的操作指引。

terminal、lite-browser、planning 同样迁移 tuple 解构和 ToolUI 渲染。Planning 的真实 Ref 发布不能遗漏；无 active plan/phase 时发布的占位对象不能谎称为完整 Plan/Phase，由 App 调整发布或实际类型。

允许差异：专用标记移除、空白整理、重复名称减少、UI 回传导致的多余 render 消失，以及 Ref 旧 formatter 迁移到 `(DataDesc)[DataType:RefName]`。必须保留：工具用途、必要业务前提、Ref 描述、原 custom label 的有效指引、非空 View 与一致提交。

原来只含 ToolUI 的 View 必须有明确普通说明；最终以 Snapshot、Messages、native tools 验证，不只检查 DOM 中没有 tool-ref。

### U7. 不迁移的业务职责

IDE 的 filePath 参数、loaded-file 检查、磁盘版本、协作锁、写后重读、partial/warning、LSP/search、持久化与 close 流程保持。普通内容更新不能无故旋转 activation；同合同 rerender 更新 committed handler，failed render 不提前发布。

不增加文件 watcher、框架 file target/version、自动重试或业务补偿。close、stop、onDelete 仍有实际区别；SDK/Runtime 对自己的对象负责，App 对自己的外部工作负责。

## 7. 影响面与兼容性评估

| 区域 | 主要文件/消费者（相对根目录） | 影响级别 | 处理要求 |
| --- | --- | --- | --- |
| Scope owner | runtime/src/core/invocation/scoped-interaction.ts；observation-registry.ts；types | 高：异步/重入/容量 | 唯一 owner，保留公开行为；按阶段提交 |
| ledger / result | runtime/src/core/invocation/invocation-ledger.ts；invocation-outcome.ts；SDK ordinary wrapper | 高：重复执行/结果事实 | 同步占位、TTL tombstone、逐次读授权、字段映射验证 |
| Snapshot/Core 出口 | runtime/src/core/snapshot/store.ts；core/index.ts | 高：公开语义 | 首批不改历史/lease；Ref profile 迁移单列 |
| 最终调用校验 | runtime/src/core/tool/view-owned-tools.ts；worker-runtime ordinary/ref；engine/app/worker-host.ts | 高：误执行 | 注册时编译，最后入口验证，保留 IPC 和授权边界 |
| 发布和 Ref | SDK hooks/tools/context；AppKernel；dom-snapshot-producer；snapshot validators | 高：跨包合同 | 类型推导、元数据、原值、命名、清理和版本整链迁移 |
| Driver | agent-driver-v2/src/core/interfaces.ts；agent-driver-v2.ts；llm-client.ts | 高：路由/续轮 | getContext 唯一入口；模型和 Driver 只有一个副作用执行者 |
| Host/IM/MCP/Skill | host/src/adapters；host/src/mcp；host/src/im；host/src/skills；host-manager-v2 | 高：生产集成 | 逐 Source 迁移，固定身份，保留错误影响范围和更新事件 |
| 历史数据（迁移取消） | host/src/core/message-service-v2.ts；host/src/types-v2.ts；host/src/im/message-store.ts | 保持项：已有会话 | 不改生产格式、历史读取边界或数据库原数据；不作为迁移工作包 |
| AOTUI Source / GUI | runtime/src/adapters/semantic-aotui-driven-source.ts；host/src/core/semantic-desktop-snapshot.ts | 中高：模型输入 | 保留 region/timestamp、并行捕获和释放 |
| IDE | demo-apps/aotui-ide/src/tui；examples；tests | 中高：真实使用 | 只改作者层和示例；业务行为作黑盒验收 |
| 其他 Demo | planning-app、terminal-app、lite-browser-app | 中：API 迁移 | 不只迁 IDE；类型、可见文本、Ref 实际消费者覆盖 |
| CLI / 容量脚本 | runtime/src/cli.ts；runtime/scripts/view-type-tool-capacity.mjs；scripts/scoped-ide.mjs | 中：低层消费 | 修释放；移除对删除工厂的深导入；注明指标定义变化 |
| 文档/技能/导出 | README/GUIDE；runtime/docs；sdk/docs；.agents/skills/aotui-app-builder；type-tests | 中：Agent 作者 | 同批更新使用路径；旧示例不再指向退出 API |
| 持久化/生命周期 | state-session、state-storage、createTUIApp、usePersistentState、App lifecycle | 高，但主改为回归 | 不顺手重设计；保持恢复、flush、删除和真实清理 |

影响面不能只按静态 import 判断，还需检查动态入口、公开 exports/声明文件、Node Worker 消息、初始化副作用、打包脚本和文本示例抽取测试。

## 8. 可行性、风险与失败处理

### 8.1 可行性判断

| 工作 | 判断 | 依据 |
| --- | --- | --- |
| 合并双 Scope owner | 高可行，风险中高 | 身份来源相同，状态可收敛；现有 close/TTL/授权/重入测试较完整 |
| 内联 ledger 包装 | 高可行，风险中 | 单生产消费者；必须保持同步占位和 tombstone |
| 最终校验收敛 | 高可行，风险中高 | 注册时已有 compiled contract；执行入口需接管最终责任 |
| Driver getContext 收敛 | 高可行，影响面大 | 已有目标接口与 AOTUI 主链；MCP/IM/恢复需专项验证 |
| ToolUI 删除 | 高可行，风险中 | 不决定普通工具资格；可见文本与空 View 是具体迁移风险 |
| Ref 统一 | 有条件可行，风险高 | 方向已确认，但类型推导、schema profile、命名和协议需先完成 U0 |
| 整体删除 ScopePolicy/历史/去重 | 不满足本轮无损约束 | 会改变正式合同及已有行为测试，故排除 |

### 8.2 风险登记

| 风险 | 可能后果 | 预防/检测 | 阻断级别 |
| --- | --- | --- | --- |
| closing 状态提前回收 | 原操作仍执行但权限/预算/close 报告已失真 | C02–C07 关闭测试、人工控制 Promise、真实 Worker 关闭 | P0 |
| 去重占位晚于用户回调 | 同一 ID 执行多次 | validator 同步重入、并发和 settled replay 副作用计数 | P0 |
| 只按名字/新 cache 分发 | 旧模型调用进入新对象 | App 重启、工具重激活、MCP 刷新、topic 切换测试 | P0 |
| schema 身份遗漏 Ref metadata | 同 wire string 合同错误复用新 payload 类型 | User→Order、对象→列表等同外观合同变化测试 | P0 |
| raw/effective 授权语义不一致 | 校验和真正执行对象不同 | 捕获输入、冻结、授权前后撤销及恶意对象用例 | P0 |
| 模型 SDK 与 Driver 双执行 | 外部工具副作用重复 | 真实 streamText 受控 provider + 一次执行计数 | P0 |
| 旧 dist 或错误链接包被测试 | 获得虚假的新实现通过 | 固定构建顺序，记录解析路径/版本/产物指纹 | P0 |
| ToolUI 裸删 | 指引丢失、空 View、投影失败 | 消息 golden 和纯 ToolUI View 用例 | P1，阻断对应批次 |
| 历史格式提前退出 | 旧会话/compaction 无法恢复 | 保留现有兼容读取/规范化及与受影响行为有关的必要回归；不实施迁移 | P0 |
| Source 错误范围意外扩大 | 可选 MCP/Skill 故障阻断 Agent | 每 Source 失败策略矩阵 | P1，阻断对应批次 |
| 统计/上限含义变更 | 隐式放宽或提前拒绝 | 两类 maxScopes、各边界 N-1/N/N+1 测试 | P0 |
| 基线脏工作树遗漏 | 丢失用户修改或比较对象错误 | M0 当前内容基线、逐提交文件清单 | P0 |

### 8.3 已发现的基线问题

以下均为静态发现，本文不把它们写成已运行复现：CLI 临时 Observation 未释放；IDE 本地示例使用旧投影字段；MCP 双执行风险；IM 只读工具续轮与并发历史恢复风险。M0/M1 先判定并建立回归，证实影响核心的先修复或阻断依赖批次。

单 App 投影失败隔离在既定评审中已列 P0，但当前对异常与冲突的处理并非完整隔离。本轮不靠 catch-all 隐藏错误：先记录现状，按既定 P0 工单分别验证预期 per-App 拒绝、意外异常和全局名称冲突。只有已明确且通过验证的修复才列允许差异；不得把新错误策略夹带成内部重构。

### 8.4 回退策略

采用小提交组，Runtime owner、结果、Worker 校验、Driver、Ref 协议分开。失败回退到该组之前已验收状态；不回退整个用户工作树。

涉及新协议/SDK 时按相互匹配的包集合回退，不能混用新 SDK 与旧 Worker。旧会话通过现有读取/规范化保持可恢复；本轮不执行破坏性存储迁移。未通过的候选路径不得以默认 fallback 方式长期留在发布版本中。

## 9. 开发计划与依赖

以下为建议的提交组，不是已执行进度。工作量是熟悉当前项目的单个开发者的粗估，不含基线缺陷扩大、外部环境和项目所有者验收等待；M0 完成后校准，不作为交付承诺。

| 阶段 | 内容与交付物 | 依赖 | 粗估 | 该组准出 |
| --- | --- | --- | --- | --- |
| M0 基线 | 当前工作树基线、源/产物解析记录、测试结果、允许差异清单初稿、影响清单 | 无 | 1–2 人日 | 基线可复现；失败明确归因；未运行不写通过 |
| M1 缺陷与风险 | CLI/示例小修；MCP/IM 静态风险复现；补必要行为测试 | M0 | 1–3 人日 | 每个成立问题独立修复；副作用/续轮/释放可验证 |
| M2 ledger 减法 | 内联单消费者包装，保留 ID/指纹/读授权 | M0 | 0.5–1 人日 | 并发/重入/重放/冲突/TTL 测试全通过 |
| M3 单一 Scope owner | 观察状态归入 State，删除第二张 Scope Map 和独立内层 owner | M2 | 2–4 人日 | close/drain、逻辑配额、并行 Context、公开 Core 消费保持 |
| M4 单刷新/时钟 | 删除嵌套 sweep、重复时钟；保留异步重新检查 | M3 | 1–2 人日 | 精确到期、clock 故障、重入与计数不变 |
| M5 最终校验/结果 | Runtime 最后入口接管 compiled 校验；减少重复结果解释 | M3；与 M4 分提交 | 2–3 人日 | handler 进入次数、参数与结果事实等价；IPC 仍有界 |
| M6 Driver 收敛 | 六类 Source 全迁 getContext；唯一执行路由；现有消息恢复保持（D3 迁移取消） | M0、M1；可与 M2–M4 并行设计 | 2–4 人日 | 全 Source 契约、真实 streamText、恢复与续轮通过 |
| M7 Ref 合同 | U0 编译验证和冻结；统一发布、参数和协议；完整组合测试 | U0 可提前；实现依赖 M5/M6 | 4–7 人日 | 协议矩阵、类型矩阵、来源/授权/预算完整通过 |
| M8 作者迁移 | ToolUI 删除；IDE、Planning、Terminal、Browser、fixture/文档迁移 | M7；普通 ToolUI 可先独立验证 | 1–3 人日 | 新 SDK 构建；模型指引/非空 View；无旧作者 API 消费 |
| M9 集成与发布候选 | 全量回归、包消费、Agent 作者验证、验收记录与版本说明 | 前述目标批次完成 | 2–4 人日 | 第 12 节全部满足；无未解释核心回归 |

保持行为的 M2–M6 可以独立于 Ref 升级交付。M7/M8 是同一协议/API 发布单元，不能先删旧 Hook 再留下无法运行的 App。每个提交组同时更新自己的消费者和相关说明，最终 M9 只做收敛核对，不把迁移债务都留到最后。

### 9.1 协作切分

- Runtime 线负责 owner、ledger、clock、关闭；一名整合者负责这些共享文件，避免多分支同时改同一 State 逻辑。
- Driver/Host 线负责 Source、模型执行拥有者、消息恢复与 IM；以当前 Runtime 合同为起点，避免等待 Ref 才收敛。
- SDK/Ref 线先完成 U0 类型与合同验证，再与 Runtime 最终调用入口合并；view-owned-tools、Snapshot metadata 和 IPC 必须集中整合。
- Demo/文档迁移依赖已冻结 API，不通过猜测未完成 helper 提前写大量样板。

### 9.2 每组交付记录

每组说明必须包含：具体问题；删除的 owner/状态/分支；保留的行为编号；涉及公开合同及迁移；实际命令和测试数；允许差异及原因；风险与回退点。不得只写“架构优化”“简化代码”或“测试通过”。

### 9.3 本轮不做的公开能力退出

Scope 公共 API、Receipt 去重/回读、ScopePolicy、历史 TTL/lease、timestamp 排序的整体删除不在 M2–M9 的无损目标内。将来如果要退出，需先证明所有保留消费方式的等价实现；不能再造兼容历史仓库/账本来假装删掉 Core，也不能无证据扩大本轮。

## 10. 测试方法与覆盖矩阵

### 10.1 基线与差异验证

在保存当前工作树的基线副本和候选副本分别构建、运行相同 fixture，比较外部可观察轨迹：View 集合/内容、工具集合/Schema、实际 handler 次数和参数、错误/副作用事实、消息顺序、通知次数与关闭事实。

只归一化随机 ID 和绝对时钟起点；必须保留身份之间相等/不等关系、事件先后、到期边界、工具调用对应关系。不能把 ID 全删、timestamp 全清或忽略错误字段来制造等价。

行为保持批次使用同一预期；Ref/ToolUI 迁移仅使用列明的允许差异。已复现缺陷修复的差异单独标注。无需在生产实现中保留双引擎，也不新增常驻比较框架。

### 10.2 Core / Runtime 确定性测试

优先复用当前测试，使用手动控制的 Promise、注入时钟和少量边界参数，不使用长 sleep 推断时序。

| ID | 场景 | 必须断言 | 现有落点/新增缺口 |
| --- | --- | --- | --- |
| T01 | 同 ID 并发、validator 同步重入、settled replay | handler/执行验证/执行授权只一次；每次读取独立鉴权 | scoped-interaction.test.ts |
| T02 | 同 ID 不同完整请求 | INVOCATION_ID_CONFLICT；新 handler 零进入 | scoped-interaction.test.ts |
| T03 | Observation 释放、历史过期、临时 degraded 后读取已完成结果 | 按现行读权限与结果寿命返回，不重新执行 | scoped-interaction.test.ts |
| T04 | receipt TTL 精确截止 | 内容过期、fingerprint 仍保留；拒绝冲突/不重新执行 | scoped-interaction.test.ts |
| T05 | project/validate/authorize/read 挂起时 close | 未授权调用不进入；whenClosed 等真实结算；计费不提前归零 | scoped-interaction.close.test.ts C02–C07 |
| T06 | handler 已进入后 close、abort 重入、多个 Scope | 不伪装未执行；所有操作 settle 后才能释放责任 | scoped-interaction.close.test.ts C01–C10 |
| T07 | 两类 maxScopes 不同且 State 正在 closing | 两种逻辑计数与准入边界和基线一致 | 针对 owner 合并新增最小用例 |
| T08 | scope/observation/lease 精确 TTL，clock 回拨/抛错 | exact boundary 拒绝；显式清理仍完成 | observation-registry.test.ts、snapshot.test.ts、close tests |
| T09 | 历史全被 pin、lease 额度耗尽 | commit/acquire 按当前码拒绝；不挤出活来源 | snapshot.test.ts、retention-lifecycle.test.ts |
| T10 | App 重启、最后一个匹配 View 关后重开、disable/enable | 旧实例/activation 拒绝；同名新对象不复活旧调用 | source-binding.test.ts、view-type-tools.v3.test.ts |
| T11 | 两个 FileDetail 关闭一个；同合同 rerender；failed render | 剩余类型激活保持；committed handler 正确；失败提交不泄漏 | SDK view-type integration、source-binding tests |
| T12 | 无效参数、额外字段、默认值、getter/非 JSON、Core 显式转换 | SDK 无隐式 coercion/default；可信转换后的冻结 effectiveInput 被授权和执行共同使用；非法输入不进入 handler | ordinary-parameter-contract、scoped-interaction.test.ts、worker-message-capture、SDK wrapper tests |
| T13 | Worker 业务成功但投影失败 | 业务事实不丢；进入 degraded；恢复不重复副作用 | worker-host.semantic-publication.e2e.test.ts |
| T14 | CLI 连续打印超过默认观察上限，打印本身抛错 | 每次临时观察释放；无泄漏/放大上限 | CLI 定向回归、IDE local example |
| T15 | DOM 与普通 TS Producer 同业务输出 | View/Tool/Ref 与失败边界相容；无 Node/DOM 倒灌纯 Core | worker-host.dual-producer-e2e.test.ts、core/public-entry.test.ts |

### 10.3 Ref 与 SDK 迁移测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| T16 | 对象、列表、Ref 数组、optional、多 Ref 与普通参数混合 | 模型字符串与 handler 只读 payload 的类型/运行值一致 |
| T17 | optional 缺省与无效已提供值 | 缺省不解析；无效值报错，不吞成缺省 |
| T18 | 重复名字、同发布者更新、迟到 cleanup、跨 App 同名 | App 内冲突拒绝；独立 App 不串；旧 cleanup 不删新发布 |
| T19 | 捕获后更新/重排/卸载，工具仍有效或已失效 | 原值不变；有效性按新合同检查；不偷读最新对象/复活旧工具 |
| T20 | User→Order、对象→列表等模型侧仍是 string 的合同变化 | 完整 metadata 改变合同身份，旧调用不复用新解释 |
| T21 | 模型对象、不可见/跨 App Ref、完整名字与路径解释 | 拒绝绕过/越界；已发布的 messages[0] 等名字按完整字符串可用，未发布时不从 messages 猜测寻址 |
| T22 | 巨大 payload、多 Ref 重复引用、展开后超限 | 总预算准确，超限在 handler 前拒绝，资源归还 |
| T23 | Ref 用于 mutating Tool | payload 保持不可变；业务写允许且由 App 校验；不恢复旧只读 Tool 限制 |
| T24 | 纯 ToolUI View、custom label、WorkspaceCreate | 普通说明保留，View 非空且成功提交，native tools 正确 |
| T25 | TypeBox 正/反类型、公开导出 | payload 推导/readonly/optional 正确；退出 API 不再可导入；文档示例可编译 |
| T26 | 版本不匹配及缺失 capability/profile | 清晰初始化/注册失败，handler 零进入，无猜测降级 |

旧“仅一个必填 Ref”“Ref Tool 必须只读”“按隐式 Tool target 选 Ref”断言属于被批准退出的旧合同，应替换为新矩阵；其中仍验证来源、预算、关闭、不可变性的用例必须迁移，不能整文件丢弃。

### 10.4 Driver、Host、历史与执行测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| T27 | 六类 Source、禁用/启用、捕获期间更新 | 本轮路由固定；原通知语义与降级粒度保持 |
| T28 | 两个 Context 与 GUI 并行，释放前一个，再释放最后一个 | 分别保留原来源；只有最后一个 owner 触发既定 Scope 关闭 |
| T29 | 模型请求失败、Source 部分捕获失败、工具失败、stop 后晚响应 | 最终释放已捕获资源；stop/Context 失效后不再启动新调用；在途工作真实结算；普通单工具失败保留批内后续调用策略 |
| T30 | MCP 真实 streamText 流产出一个 tool call | 副作用严格一次；结果/ID 对应；不是占位返回；只在 Driver 路由执行 |
| T31 | MCP catalog 刷新/禁用、Host topic 切换 | 旧闭包不转向新 client/topic；按当前控制拒绝 |
| T32 | unchanged/changed/reopened View 与混合 region | timestamps、区域内顺序和最终排列保持现行规则 |
| T33 | 旧 result、新 output、assistant JSON string、多 call/result、附件/provider data | 恢复后协议完整，不丢字段，不把用户文字误解析为工具结构 |
| T34 | compaction、相同 timestamp、IM 恢复前收到新消息、并发加载 | 去重/顺序保持；所有 capture 等待同一必要加载；失败不永久锁死 |
| T35 | Host/IM 只读工具不改变 View | 保存结果后恰当续轮；最终 assistant 不无限唤醒 |
| T36 | 跨 Source 同名工具、可选 Source 故障 | 保留既有覆盖/受控降级，AOTUI 内冲突不被默默吞掉 |

真实 streamText 专项可复用当前已安装 AI SDK 的 MockLanguageModelV3/受控流工具或替换 provider-factory 的模型创建函数。不得替换 LLMClient.call 或 streamText 来绕过自动执行风险，也不调用真实外部 MCP 副作用。

### 10.5 IDE、持久化和包消费

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| T37 | 空 IDE→打开 test.txt→编辑→关闭→重开 | 动态编辑能力、最新唯一 View、ToolResult 不重复正文、旧激活失效 |
| T38 | a/b 两文件，只关 a；外部修改、版本冲突、部分成功 | 类型工具与 App 目标检查各守边界，业务 warning/partial 不失真 |
| T39 | LSP/search、WorkspaceCreate、App stop/close/delete | 资源与页面按合同清理；关闭不误删数据；删除按既有 App 规则执行 |
| T40 | late restore、setter、flush 失败、卸载、持久化清除 | state-session 与 binding 生命周期保持，不把 ready 当作已落盘 |
| T41 | Planning/Terminal/Browser 实际构建与页面 | 没有漏迁移 ToolUI/Ref；新 SDK 不破坏其他 App |
| T42 | 独立 /core、已构建包/安装包、DOM/TS Producer、版本错配 | 类型和运行导出一致；不依赖 monorepo alias；错配明确失败 |

IDE 文件写入测试只用临时目录和现有测试夹具，不编辑用户真实项目文件；模型和 MCP 采用受控输入。确需真实模型验收时使用隔离测试 App/数据，另行记录模型配置，不能让真实模型试验替代确定性回归。

### 10.6 稳定性与 Agent 作者验证

- 对受影响 owner/Source 使用现有容量脚本和至少 300 个顺序回合的捕获—调用—释放循环；不得累积整会话 Receipt 或 Observation。并发边界使用实际 configured limit 的 N-1/N/N+1。
- inspect/关闭报告证明受管理集合与逻辑字节按合同归零；已交给调用者的不可变值、真实未结算 Promise 不被错误计为已回收。
- 重入和关闭交错由可控 Promise 确定性覆盖；不用大量随机 sleep 充当竞态证明。
- 注册后多次普通调用不应在同一 Worker 重复编译同一合同；SDK 定义诊断和跨边界校验仍按职责保留。
- 如使用现有性能脚本，固定输入、机器、构建与度量含义；改造后的同名指标定义不得悄悄变化。不承诺尚未测量的吞吐或 RSS 改善。
- 用新公共文档让一个没有私有实现上下文的 Agent 完成最小编辑 App，以及对象/optional/多 Ref 示例；记录编译、行为通过、修复轮次和私有 API 依赖。默认作者无需创建 Scope/Observation/Binding/Receipt。

## 11. 可执行验证入口

以下命令在项目根目录运行，来自当前各包脚本或已确认文件；本轮写文档时未执行。源码与 dist 必须一致，跨包测试前先构建依赖，不能使用旧 dist 获得假通过。

### 11.1 基线构建与类型检查

```bash
pnpm -C agent-driver-v2 run build
pnpm -C runtime run build
pnpm -C sdk run build
pnpm -C sdk exec tsc -p tsconfig.public-api-types.json --noEmit
pnpm -C demo-apps/aotui-ide run build
```

执行前核对实际包解析路径及 link/override；如果环境不具备依赖或旧构建产物，先解决并记录，不能静默联网安装未知版本或修改锁文件。其他 Demo 与 Host 按其当前脚本构建；Host 发布验证还需 GUI 构建。

### 11.2 Core 与真实 Worker 定向回归

```bash
pnpm -C runtime exec vitest run src/core/invocation/scoped-interaction.test.ts src/core/invocation/scoped-interaction.close.test.ts src/core/invocation/observation-registry.test.ts src/core/tool/source-binding.test.ts src/core/tool/view-type-tools.v3.test.ts src/core/snapshot/snapshot.test.ts src/core/snapshot/retention-lifecycle.test.ts src/core/public-entry.test.ts
pnpm -C runtime exec vitest run src/adapters/semantic-aotui-driven-source.test.ts src/engine/app/worker-host.scoped-interaction-e2e.test.ts src/engine/app/worker-host.semantic-publication.e2e.test.ts src/engine/app/worker-host.dual-producer-e2e.test.ts
```

内部 factory 退出时，相关测试路径可以随职责调整，但测试编号与原行为覆盖必须能映射到新落点。

### 11.3 Driver 与 Host/IM 回归

```bash
pnpm -C agent-driver-v2 exec vitest run tests/core/agent-driver-v2.test.ts tests/core/state-machine.test.ts tests/core/context-regions.test.ts tests/core/semantic-context.test.ts
pnpm -C host exec vitest run test/adapters/system-prompt-source.test.ts test/host-driven-source.test.ts test/mcp-driven-source.test.ts test/im/im-driven-source.test.ts test/im/im-session-manager.test.ts test/message-service-v2.test.ts test/session-manager-v3.compaction.integration.test.ts test/session-manager-v3.tool-receipts.test.ts test/source-controls.test.ts test/session-manager-v3.agent-source-controls.test.ts test/host-manager-v2.integration.test.ts
```

新增的 MCP 真实 streamText、Skill Source 最小合同加入对应包常规测试；仅保留与受影响行为有关的既有历史恢复回归，不为已取消的 D3 新建迁移测试。不能仅修改旧测试调用私有方法的方式，却删除它们原来证明的行为。

### 11.4 SDK、IDE 与全量候选验证

```bash
pnpm -C sdk run test:run
pnpm -C demo-apps/aotui-ide run test:run
pnpm -C runtime run test:run
pnpm -C agent-driver-v2 exec vitest run
pnpm -C host run test:run
pnpm -C host run build:all
```

IDE test:run 会先 build，并运行 Jest、ViewType Tool、WorkspaceCreate 和集成脚本；集成脚本包含常规、边缘、关闭和容量场景。另补已存在的 LSP E2E、相关业务写入测试，以及其他 Demo 的当前测试命令。

公开消费使用现有 runtime/tests/w10-package-consumer.mjs 及其当前构建/安装前提，另覆盖目标协议版本矩阵。执行前先读脚本，不编造参数，也不把 monorepo 源码导入成功当作 tarball 消费成功。

## 12. 准出条件与发布门槛

以下全部是实施后的验收条件；本文件创建时均不标为已通过。任何 P0/核心行为缺口或无法解释的差异都阻断对应发布，不能靠删测试、修改预期或引用历史验收记录放行。

### G0. 基线可追溯

- 当前工作树、依赖解析、构建产物和测试环境有明确记录；新实现确实被运行。
- 每个基线失败有“已修复 / 与本次无关且证据充分 / 阻断”的判定。核心场景不能以“基线本来就坏”豁免。
- 不覆盖用户已有修改，提交范围清楚，回退到已验收任务状态可操作。

### G1. 合同冻结与迁移完整

- C01–C22 对应的入口、所有者和测试明确；没有未决定但影响执行的语义。
- U0 的 helper、metadata、Schema 支持、命名、预算、错误码和协议版本全部通过可编译/可运行用例冻结。
- 所有保留消费者都有迁移与验证；旧 SDK/Worker/App 错配明确拒绝，handler 零进入。
- API 退出与行为保证有逐项映射；未列允许差异的可观察变化为阻断项。

### G2. 核心行为全通过

- T01–T42 中属于本次交付范围的用例全部实际运行并通过，未运行必须标记阻断而不是留空。
- 用户的打开文件→编辑→唯一最新 View→关闭→重开流程通过真实 Worker/SDK/Source/Driver 集成。
- 去重、逐次读授权、TTL、结果不可读、unknown/partial、旧身份失效和资源结算均无回归。
- 持久化、App stop/close/delete、DOM/TS Producer 与纯 Core 继续通过。

### G3. 执行和消息链路唯一且正确

- 生产 Source 只有 getContext 主路径，无遗漏 IM/Skill/MCP。
- 同一个正常模型 tool call 在真实 streamText 链路只触发一个副作用 executor；ID、结果和通知对应。
- 同 Scope 同 ID 的重放仍遵守现有去重合同；新的合法调用 ID 不被误当作跨轮幂等请求。
- 迟到响应、topic/client 切换、后续 capture、关闭与禁用不会重绑旧调用。
- Host/IM 只读工具能续轮；最终 assistant 不无限自唤醒。
- 消息 region/timestamp/排序、tool-call/result 邻接和旧历史恢复保持。

### G4. 所有权与边界准确

- close/release 只撤销各自的权限与引用：已释放 Observation 不支持新的绑定执行，已释放 Context 不再派发调用，已关闭 Scope 不接纳新工作；其他有效 owner 与合同允许的已完成结果回读仍可用。实际 Promise 结算前不报告其责任与资源已释放。
- 两种逻辑 Scope 容量、观察/执行来源预算与精确 TTL 保持，不把不同指标混为一项。
- 正常、异常、取消、容量拒绝与重复 cleanup 后，受管理计数按合同归零。
- 连续回合和并行 Context 无持续增长；不通过放宽默认上限、自动驱逐活引用或隐藏对象改变结果。

### G5. 减法确实落地

- Core 只有一个 Scope 生命周期 owner；第二张 Scope owner Map、第二套 clock 和嵌套全量 sweep 退出。
- ledger 薄工厂在无独立职责后退出；调用记录行为仍通过测试。
- 同 Worker 同一段执行无重复编译和重复校验；最终 Runtime 校验保留。
- Driver 全局 map fallback 和分读旁路退出，没有新的同功能 Manager 替代。
- Ref 升级完成时，旧 useViewSnapshotTool、独立旧 Ref 调用分支、ToolUI 作者类型/返回组件和仓内生产消费一起退出。
- 没有新增依赖、常驻兼容双引擎、无消费者保留区或新的通用框架。必要 Ref helper 是已确认能力的表达，不能扩展成另一套 DSL。

### G6. 模型与 Agent 作者体验

- 模型可见用途、操作前提、Ref 描述和页面内容没有丢失；仅允许已记录的 ToolUI/Ref 表达差异。
- 不产生空 View、重复当前 View、静态指令混入动态区或失效工具可执行的状态。
- 新文档和类型足以完成最小 App 与 Ref 示例；普通作者私有 API 依赖为零，不需要手工维护四种低层对象。
- 示例、文档、导出、声明文件和实际发布包一致，不再把目标伪代码写成已经存在的 API。

### G7. 版本发布与 Legacy 退出

- 形成相互兼容的 Runtime/SDK/Driver/Host/App 发布集合，验证真实构建/安装包，不只源码 alias。
- 不兼容 authoring/协议变更明确记录；没有默默把旧参数解释成新合同的回退。
- AGENTS.md 第六节要求项目所有者本人完成新 Semantic 路径测试验收，之后才可全面退出 Legacy。本文不代替该事实；当前未记录为已完成。
- 已有明确验收后不重复索取同一退出决定；尚无验收时不凭内部测试声称 Legacy 已可删除。

### 12.1 建议的验收记录模板

| 项目 | 证据 | 结果 |
| --- | --- | --- |
| 工作树/构建基线 | commit 或内容指纹、解析路径、工具版本 | 待执行 |
| Runtime/Core | 命令、测试文件/数量、关键事件轨迹 | 待执行 |
| SDK/Ref/ToolUI | 类型矩阵、运行矩阵、消息差异 | 待执行 |
| Driver/Host/IM/MCP | 真实 streamText 执行计数、恢复/续轮结果 | 待执行 |
| IDE 与其他 Demo | 临时数据集、Worker E2E、业务结果 | 待执行 |
| 资源/容量 | configured limits、inspect/close 报告、连续回合结果 | 待执行 |
| 包与版本错配 | 安装包标识、组合结果、拒绝诊断 | 待执行 |
| 减法清单 | 删除 owner/状态/分支/API，新增必要代码及原因 | 待执行 |
| 项目所有者 Semantic 验收 | 实际验收范围、记录与日期 | 待完成，不能由本文代填 |

## 13. 源码与测试证据索引

下列链接相对项目根目录；它们用于定位当前合同和变更落点，不代表相应测试已在本轮执行。关键符号应优先于可能漂移的行号。

| 主题 | 主要依据 |
| --- | --- |
| 产品约束、减法和 Legacy 退出条件 | [AGENTS](AGENTS.md)、[评审与决策记录](deepseek_review.md)、[minimalist](.agents/skills/minimalist/SKILL.md) |
| 双 Scope owner、去重、读取、关闭 | [scoped-interaction](runtime/src/core/invocation/scoped-interaction.ts)、[observation-registry](runtime/src/core/invocation/observation-registry.ts)、[公开类型](runtime/src/core/invocation/scoped-interaction-types.ts)、[ledger](runtime/src/core/invocation/invocation-ledger.ts) |
| 重入、重放、TTL、真实结算 | [invocation tests](runtime/src/core/invocation/scoped-interaction.test.ts)、[close tests](runtime/src/core/invocation/scoped-interaction.close.test.ts)、[observation tests](runtime/src/core/invocation/observation-registry.test.ts) |
| 历史、lease、容量与 dispose | [store](runtime/src/core/snapshot/store.ts)、[store types](runtime/src/core/snapshot/types.ts)、[snapshot tests](runtime/src/core/snapshot/snapshot.test.ts)、[retention tests](runtime/src/core/snapshot/retention-lifecycle.test.ts) |
| 工具身份、Ref 原来源、普通类型激活 | [source-binding](runtime/src/core/tool/source-binding.ts)、[snapshot-value-arguments](runtime/src/core/tool/snapshot-value-arguments.ts)、[view-owned-tools](runtime/src/core/tool/view-owned-tools.ts)、[V3 Tool tests](runtime/src/core/tool/view-type-tools.v3.test.ts) |
| 参数单源和 SDK 推导限制 | [view-type-tool](sdk/src/tools/view-type-tool.ts)、[typebox-schema](sdk/src/tools/typebox-schema.ts)、[ordinary contract](runtime/src/core/tool/ordinary-parameter-contract.ts)、[snapshot value contract](runtime/src/core/tool/snapshot-value-parameter-contract.ts) |
| Worker 最后入口与结果 | [ordinary invocation](runtime/src/worker-runtime/ordinary-invocation-v2.ts)、[SDK wrapper](sdk/src/utils/ordinary-parameter-tool.ts)、[terminal](runtime/src/core/tool/invocation-terminal.ts)、[outcome](runtime/src/core/invocation/invocation-outcome.ts) |
| 发布与真实 Worker | [worker-runtime](runtime/src/worker-runtime/index.ts)、[worker-host](runtime/src/engine/app/worker-host.ts)、[publication E2E](runtime/src/engine/app/worker-host.semantic-publication.e2e.test.ts) |
| SDK ToolUI、Ref 和原子提交 | [useViewTypeTool](sdk/src/hooks/useViewTypeTool.ts)、[useViewSnapshotTool](sdk/src/hooks/useViewSnapshotTool.ts)、[useArrayRef](sdk/src/hooks/useArrayRef.ts)、[projection tests](sdk/src/projection-coordinator.test.ts)、[Tool integration tests](sdk/src/view-type-tool.integration.test.tsx) |
| Ref 注册与空 View 风险 | [AppKernel](runtime/src/worker-runtime/app-kernel/AppKernel.ts)、[DOM producer](runtime/src/worker-runtime/dom-snapshot-producer.ts)、[fragment extractor](runtime/src/worker-runtime/view-fragment-extractor.ts) |
| Driver 合同、路由和消息排序 | [interfaces](agent-driver-v2/src/core/interfaces.ts)、[driver](agent-driver-v2/src/core/agent-driver-v2.ts)、[context-regions](agent-driver-v2/src/core/context-regions.ts)、[llm-client](agent-driver-v2/src/core/llm-client.ts) |
| AOTUI Context、Scope 共享、timestamp | [Semantic Source](runtime/src/adapters/semantic-aotui-driven-source.ts)、[Source tests](runtime/src/adapters/semantic-aotui-driven-source.test.ts)、[GUI capture](host/src/core/semantic-desktop-snapshot.ts) |
| MCP 副作用入口与缓存 | [MCP manager](host/src/mcp/index.ts)、[MCP Source](host/src/mcp/source.ts) |
| Host/IM 集成及历史恢复 | [Host manager](host/src/core/host-manager-v2.ts)、[message service](host/src/core/message-service-v2.ts)、[Host Source](host/src/adapters/host-driven-source.ts)、[IM Source](host/src/im/im-driven-source.ts)、[IM store](host/src/im/message-store.ts)、[row conversion](host/src/types-v2.ts) |
| CLI/示例释放遗漏 | [CLI](runtime/src/cli.ts)、[local IDE example](demo-apps/aotui-ide/examples/local-scoped-ide.mjs) |
| IDE 作者层与业务边界 | [ScopedIDEApp](demo-apps/aotui-ide/src/tui/ScopedIDEApp.tsx)、[WorkspaceCreateView](demo-apps/aotui-ide/src/tui/WorkspaceCreateView.tsx)、[IDESession](demo-apps/aotui-ide/src/core/ide-session.ts)、[IDE integration runner](demo-apps/aotui-ide/tests/run-scoped-ide-integration.mjs) |
| 其他真实作者消费者 | [PlanningApp](demo-apps/planning-app/src/tui/PlanningApp.tsx)、[PlanListView](demo-apps/planning-app/src/tui/PlanListView.tsx)、[PlanDetailView](demo-apps/planning-app/src/tui/PlanDetailView.tsx)、[TerminalApp](demo-apps/terminal-app/src/tui/TerminalApp.tsx)、[LiteBrowserApp](demo-apps/lite-browser-app/src/tui/LiteBrowserApp.tsx) |

## 14. 本次文档交付状态

本次交付为本技术方案文件。已完成源码/文档静态核对、真实消费者和测试入口梳理、风险与准出定义；未实施 Runtime/SDK/Driver 改造，未执行本文项目测试命令，未提交、发布或替代项目所有者验收。

实施时先更新 M0 基线与实际测试记录，再按提交组推进。无法证明保持核心行为的删除，不能进入行为保持批次；对已经确认的目标合同迁移，必须先冻结差异和完整验证，再删除旧实现。
