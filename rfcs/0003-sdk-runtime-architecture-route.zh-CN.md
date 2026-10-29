# RFC 0003 SDK 与 Runtime 技术路线及演进设计

- 状态：RD 总体路线已接受；具体 API、实现与后续里程碑逐项验收。见 [W00 / D0 负责人签署](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/rfcs/sdk-runtime-delivery/w00-review-20261024T143800Z/ACCEPTANCE.zh-CN.md)。
- 日期：2026-10-24。
- 范围：SDK、Runtime Core、两者之间的适配接口，以及必要的 IDE 验证切片。
- 基线：当前工作树，HEAD 为 789ef07，包含既有未提交修改；HEAD 本身不能复现本文描述的全部实现。
- 推荐路线：**RD，进程内语义微内核，保留 Preact SDK，通过双 Producer 验证，按能力推进、按应用执行实例切换。**
- 本 RFC 定义目标与实施门槛；文中的目标接口不表示已经发布。

## 1 决策与适用范围

AOTUI 应将“观察什么、引用谁、允许调用什么、执行结果是什么”定义为稳定的框架契约。Runtime Core 维护这些契约；具体 Host、DOM、Worker、模型接口和业务资源通过适配器接入。

推荐复用现有 Snapshot Core、View-owned Tools 和来源绑定执行模块，逐步让它们成为真实应用的唯一语义依据。Preact 继续作为默认应用开发方式，同时用一个普通 TypeScript Producer 验证 Core 的独立性。

核心应拥有交互正确性所需的规则，不接管应用数据库、文件系统或业务状态管理。Markdown 可以继续承载 View 内容；工具的身份、可用性和引用含义必须来自结构化契约。

例如，调用方在文件 A 的视图中看到一个工具，随后界面关闭 A、打开 B。即使两者复用了同一个公开 viewId，旧调用也不能落到 B 上。这条规则应由 Core 保证，在 Preact 界面、无界面应用和未来的其他 Host 中保持一致。SDK 的价值是让应用作者自然获得这种保证，而无需自行维护快照编号和调用绑定。

本次范围不包含 Mobile、Agent Driver 改造、完整 Host 重写、远程 Runtime 服务、全仓拆包和依赖大版本升级。IDE 的组件及服务用于验证 SDK/Runtime，不新增 IDE 业务功能。

### 1.1 与现有 RFC 的关系

| 文档 | 承接内容 | 本 RFC 拟明确或调整的内容 |
| --- | --- | --- |
| [RFC 0001 技术基线](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/rfcs/0001-semantic-runtime-technology.zh-CN.md) | 核心独立、普通公共 API、Schema 互操作、准确结果语义 | 依赖升级与语义迁移分开；Effect、Node、TypeScript 等版本升级不作为本轮前置条件 |
| [Runtime Core 语义契约](</Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/Runtime Core Semantic Contract RFC/00-charter.md>) | Runtime 拥有提交权、单 App 快照一致性、可替换 Producer | 补充观察发放、调用绑定、SDK 收敛和退出兼容路径的门槛 |
| [View-owned Tool 提案](</Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/Runtime Core Semantic Contract RFC/07-view-owned-tool-identity-proposal.md>) | 按实例拥有 handler，按类型聚合公开定义 | 复用现有实例模型；本轮不新增平行的 AppTool 注册体系 |
| [RFC 0002 语义核心收敛](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/rfcs/0002-semantic-core-consolidation.zh-CN.md) | M5 执行切片、五态结果、业务适配器边界 | 比较替代路线，明确后续架构、协议映射、SDK 和迁移计划 |

本 RFC 获接受后，在上述范围内以本 RFC 的决策为准；既有验证记录保留其原始范围。旧文档中的测试数量和实现描述不能自动视为当前默认路径的保证。

新契约统一使用 Tool、ToolDefinition、ToolBinding、ToolInvocation、ToolOutcome。实验中的 Action 与此处 Tool 对应，不建立第二套并行公共概念。现有 ActionOutcome、OperationResult 等代码名称通过版本化适配逐步收敛，无需在第一阶段全仓改名。

## 2 当前基础与关键问题

| 当前事实 | 长期影响 | 依据 |
| --- | --- | --- |
| 默认 App 生命周期和组件工厂要求 DOM 容器 | 无界面应用仍需适应 DOM 模型 | [App 接口](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/spi/app/app.interface.ts:45)、[组件工厂](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/spi/component-factory.interface.ts:158) |
| 默认执行链与新 Snapshot Core 并存 | 相同调用可能受两套有效性规则约束 | [Runtime 默认入口](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/facades/facades.ts:61)、[新 Snapshot Core](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/core/snapshot/store.ts:50) |
| 旧工具表按 ViewType 和名称保存单个 handler | 同类型多实例的注册与清理可能相互影响 | [旧注册表](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/worker-runtime/app-kernel/AppKernel.ts:713) |
| SDK 参数经过多次转换，旧导出遗漏 constraints | 对外参数描述与实际校验可能不一致 | [参数导出](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/worker-runtime/index.ts:803) |
| SDK 持久化直接使用本地文件系统及 DOM 关闭事件 | 环境迁移和失败反馈受限 | [状态存储](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/hooks/usePersistentState.ts:51)、[关闭处理](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/hooks/persistence-shutdown.ts:27) |
| SDK 暴露部分在组件模式下不可用的接口 | 使用者在运行时才发现接口不成立 | [组件 Context](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/components/View.tsx:249) |
| M5 已有来源绑定、有限去重和五态结果 | 可以复用执行基础，但尚未成为默认公共入口 | [M5 执行器](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/core/invocation/bound-action-executor.ts:152) |
| V2 Producer 明确限制旧工具混入 | 单个 App 内随意混合新旧语义不可作为迁移捷径 | [V2 Producer](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/worker-runtime/dom-snapshot-producer.ts:167) |

应保留的基础包括组件式开发体验、业务服务与框架机制分离、不可变 Snapshot Store、View 实例身份、来源选择器，以及纯内存契约测试。

## 3 四条候选技术路线

RA、RB、RC、RD 仅为本 RFC 的路线编号，与既有文档中的方案字母无关。

### 3.1 RA 持续加固现有 DOM Runtime

保留 DOM、IndexMap、AppKernel 与现有工具路由，逐项修复注册冲突、参数丢失、引用范围和生命周期问题。

优点是交付快、应用迁移少、短期回归风险较低。现有调试经验可以直接复用。

代价是交互语义仍主要由 DOM 运行链决定。后续引入第二种应用表达方式时，容易复制另一套解释规则。每新增能力都需要继续维护旧注册、快照索引与当前状态之间的隐含关系。

适用于维护桌面产品、短期稳定性优先的目标。作为长期通用框架路线，不能通过核心独立性的验收。必要的兼容修复仍可采用这一路线。

### 3.2 RB 建立独立新 Runtime 并整体迁移

以无 DOM 的应用 API 为起点，建立新 Runtime 与新 SDK，随后按大版本迁移现有应用。独立实验可提供设计素材，原 Runtime 在过渡期继续维护。

优点是公共 API 可以重新设计，不必长期承担历史重载与内部类型。若项目没有现有消费者，能够较快形成整洁的开发模型。

代价是需要重新覆盖已有快照保留、实例身份、Worker 竞态与 IDE 行为。新系统稳定之前，团队同时维护两个完整产品；开发者需要承担较大的迁移成本。实验代码也不能直接等同于生产替代实现。

适用于已有接口缺乏保留价值、允许明确破坏性升级、并具备专门迁移预算的情形。

### 3.3 RC 协议优先的独立 Runtime 服务

先定义序列化协议，将 Runtime 运行在独立服务或进程中，SDK 作为客户端，通过协议发布状态、取得观察和调用动作。

优点是执行环境边界清楚，天然有利于多语言接入、远程运行和故障隔离。协议消费测试可成为长期兼容依据。

代价是首次迁移就要处理连接、认证、协议协商、重连、重复请求与未知结果。网络或进程隔离本身也不能解决引用和动作绑定问题，仍需要完整的语义核心。

适用于远程执行、多宿主并行访问或跨语言接入已经成为明确业务需求的阶段。目前会显著增加交付和运维负担。

### 3.4 RD 渐进迁移到语义微内核

继续使用现有 Runtime 和 Preact SDK，以已有 Core 为基础建立唯一语义契约。DOM Producer 与普通 TypeScript Producer 都发布同一类结构化快照，执行统一进入 Core。现有运行机制通过适配器逐步接入。

优点是能够复用当前正确性工作，同时用真实 IDE 能力验证抽象。应用作者继续使用组件和 Hook，核心则能够脱离 DOM 工作。

代价是过渡期仍需维护兼容路径，并且必须严格控制模式选择、协议版本和退出条件。若只增加新 Core 而不切换实际执行依据，收益不会兑现。

适用于当前项目。推荐采用这一路线，并把兼容退出写入每个迁移阶段的验收。

## 4 比较方法与推荐结论

先检查硬条件，再比较成本。硬条件为：核心语义可脱离 DOM、原始观察能够绑定执行、现有 IDE 行为可验证迁移、失败不会绕过严格规则执行。

下表为针对当前仓库状态的架构判断，不是性能测量或工期承诺。各维度按 1 至 5 分评价，5 分更有利；总分为各项“权重 × 得分 ÷ 5”之和。

| 评价维度 | 权重 | RA | RB | RC | RD |
| --- | --- | --- | --- | --- | --- |
| 交互正确性与契约统一 | 30 | 2 | 5 | 4 | 5 |
| 现有实现复用与迁移风险 | 20 | 5 | 1 | 2 | 4 |
| 对 Host 和 DOM 的独立性 | 20 | 1 | 5 | 5 | 5 |
| SDK 长期开发体验 | 10 | 4 | 5 | 3 | 4 |
| 首个真实切片的交付成本 | 10 | 5 | 1 | 1 | 3 |
| 运维与排障负担 | 10 | 5 | 4 | 1 | 4 |
| **加权总分** | **100** | **64** | **74** | **62** | **88** |

RD 的优势来自已有 Core 可复用，以及无需同时更换应用开发模型和运行环境。RB 在新 SDK 设计自由度上更好，但当前应用和契约资产使整体重写的成本明显增加。RC 在明确需要远程、多语言运行时应重新评估。

如果目标退回“只维护当前桌面产品”，RA 的权重会上升；如果完全没有兼容要求，RB 的吸引力会增加。当前目标和代码基础下，选择 RD。

## 5 目标架构与职责

~~~mermaid
flowchart TB
    App["应用业务状态与服务"] --> SDK["Preact SDK 或普通 TypeScript 应用"]
    SDK --> Producer["Snapshot Producer"]
    Producer --> Commit["Core 提交与快照存储"]
    Commit --> Observe["观察发放与工具绑定"]
    Observe --> Invoke["Core 调用协调"]
    Invoke --> Execute["业务执行适配器"]
    Execute --> App
    Observe --> Present["文本和检查器投影"]
    Env["环境适配器"] --> Commit
    Env --> Invoke
~~~

图中的边表示数据或能力交接。实现依赖应向契约层收敛，Core 不导入具体 SDK、Host 或资源适配器。

| 部分 | 负责 | 不承担 |
| --- | --- | --- |
| Core 契约与存储 | 身份、提交校验、版本、历史、租约、健康状态 | 读取文件、渲染 DOM、管理业务数据库 |
| 观察发放 | 将已提交状态裁剪为某个可信调用作用域可见的工作切片，登记绑定 | 构造模型消息、授予永久业务权限 |
| 调用协调 | 验证来源、解析 Ref、输入校验、当前有效性检查、去重、结果记录 | 替资源层模拟数据库事务 |
| Preact SDK | 生命周期映射、View 和 Tool 声明、状态投影、开发者反馈 | 实现 Worker、选择文件存储目录 |
| Producer | 从已就绪的应用状态构造 Draft | 自行发放权威 snapshotId 或跳过 Core 校验 |
| 环境适配器 | Worker、配置、存储、时钟、关闭驱动、可信调用身份 | 重新解释 Tool/Ref 的核心含义 |
| 业务执行适配器 | 当前授权、业务校验、真实条件写入、外部任务状态 | 将传输成功当成业务成功 |

先建立内部模块边界，暂不扩大 npm 包数量。Core 生产源码的依赖检查应禁止使用 document、window、HTMLElement 等环境全局，或导入 Preact、Node Worker、文件系统、Host 和模型 SDK；标准 Promise、AbortSignal、只读 JSON 类型以及可注入时钟可以使用。

当前 SPI 的大范围导出不能直接作为未来核心公共入口。建立最小的契约导出，再验证它的声明文件不会通过间接导入带入环境类型。

## 6 核心语义与不变量

### 6.1 对象定义

| 对象 | 含义与所有权 |
| --- | --- |
| AppInstance | 一次应用执行的身份；重启后改变 |
| ViewInstance | 一个逻辑 View 的具体挂载期；公开 viewId 可复用，实例身份不复用 |
| AppSnapshot | 单个 AppInstance 一次成功提交的不可变语义投影 |
| WorkspaceSnapshot | 多个 AppSnapshot 版本指针的组合，保留版本向量，不提供跨 App 原子事务 |
| Observation | 特定可信调用作用域取得的工作切片，关联固定的源快照集合 |
| Ref | 原始 Observation 中的快照值或业务实体定位信息 |
| ToolDefinition | 可复用的公开描述和输入契约，不包含可序列化 handler |
| ToolBinding | 定义与具体 ViewInstance、绑定版本及必要业务前置条件的关联 |
| ToolInvocation | 带原始 observationId、bindingId、invocationId 和输入的一次逻辑调用 |
| ToolOutcome | 业务完成、拒绝、失败、受理或未知的明确结果 |

本轮所有 Tool 仍归属于真实存在的逻辑 View。工作区级操作可由常驻 Workspace View 拥有，无界面应用也可以建立逻辑 View。出现实际无法由 View 所有权表达的案例后，再讨论新增 App 级注册接口。

### 6.2 必须保持的规则

1. Core 验证并提交 Draft；读取当前状态本身不创建新语义版本。
2. 单个 AppSnapshot 内 View、Ref、Tool 来自同一就绪的投影周期。
3. 快照为有容量上限的独立 JSON 值，不能保留开发者对象的可变别名或 handler。
4. 旧 Ref 和旧 ToolBinding 不得静默改绑到当前同名对象。
5. View 卸载立即撤销活态执行资格，不能等待下一次快照发布才生效。
6. 同类型多 View 可共用 ToolDefinition，但分别拥有 handler；清理一个实例不能清理另一个。
7. 未影响目标、参数契约和业务条件的显示变化，不应使所有绑定失效。
8. 可见性与执行权限分别检查；当前授权和资源前置条件由可信适配器兑现。
9. 提交失败不部分发布；保留的 lastGood 必须显式标记过时，不能伪装为当前可执行观察。
10. 相同逻辑调用的重复请求不再次执行；同 ID 不同请求明确拒绝。
11. 生命周期结束和超时不能证明外部副作用已回滚。
12. Observation、租约、调用记录和诊断都必须有明确的容量与保留边界。

现有 Snapshot Core 与来源选择器是这些规则的实现基础。[Snapshot 类型](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/core/snapshot/types.ts)、[来源绑定](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/core/tool/source-binding.ts)

## 7 观察与调用协议

### 7.1 观察发放

目标流程为：

1. 环境适配器创建可信调用作用域，绑定调用身份、授权策略和生命周期。
2. Core 读取已经提交的 AppSnapshot；不在 observe 内隐式执行任意业务 I/O。
3. 策略适配器确定可见 View、内容、Ref 和 Tool；Core 验证裁剪后的引用闭合性。
4. 对该观察需要保留的源快照取得有期限租约。
5. 发放 observationId、过期时间及该观察内可用的 ToolBinding，保存在 Core 所属记录中。
6. 返回序列化观察，供任意消费端使用。

策略裁剪不得留下指向隐藏对象的可执行引用。结构化内容可以提供精确裁剪；任意 Markdown 默认按整个内容块保留或隐藏，Core 不承诺识别其中所有敏感业务字段。应用和策略适配器负责内容安全。

Observation 有效期不能超过其源快照的可用租约。容量不足时拒绝发放新观察；到期、撤销或作用域关闭时释放租约。租约只保留来源，不承诺真实资源没有变化。

### 7.2 目标调用形态

以下为目标契约草图，尚非现有导出：

~~~ts
interface ToolInvocation {
  observationId: string;
  toolBindingId: string;
  invocationId: string;
  input: JsonObject;
}

interface InteractionScope {
  observe(selection: ObservationSelection): Promise<Observation>;
  invoke(request: ToolInvocation): Promise<ToolOutcome>;
  close(): Promise<CloseReport>;
}
~~~

InteractionScope 由可信环境创建。调用方不能通过 input 自报角色、租户或权限，也不能提交一份自造 Tool JSON 代替登记过的绑定。ID 不是授权凭证；任何跨进程接入仍需验证调用身份及当前权限。

### 7.3 调用顺序

首次调用执行以下步骤：

1. 校验请求结构并复制输入，拒绝函数、循环引用、非法数值和超限载荷。
2. 在可信作用域内以 invocationId 检查完整请求指纹，预留记录，防止并发重复进入。
3. 从原始 Observation 查找登记过的 ToolBinding，检查有效期和源快照。
4. 检查当前 AppInstance、ViewInstance 和工具绑定版本。
5. 按登记过的参数契约验证输入，仅对显式声明的 Ref 字段从原始观察解析。
6. 生成 effectiveArgs 与内部来源记录；普通字符串不参与猜测式 Ref 解析。
7. 每次异步校验或授权返回后，重新核对原来源、活态绑定和取消状态。
8. 执行业务适配器；它在真实操作边界验证当前授权和资源前置条件。
9. 校验并规范化有大小上限的 ToolOutcome，保留回执并释放本次执行租约。进入业务执行后的异常或不合规回执按 unknown 处理，不能猜测为无副作用失败。

原始输入、解析后参数和引用来源分别保存为内部概念。诊断默认只记录标识和摘要，不自动回显完整 Ref 内容。

同作用域的同 ID 同请求重用既有结果；同 ID 不同请求返回冲突。返回已存结果前也需确认当前调用者仍可读取该结果。恢复执行不使用一份新观察偷偷替换旧请求；需要重新观察时，应形成明确的新逻辑调用。

### 7.4 与现有实现的映射

| 现有对象 | 目标关系 |
| --- | --- |
| AppSnapshotV2 | 继续作为应用投影的权威来源 |
| snapshotId、toolId、viewId 固定组合 | 作为 ToolBinding 的来源事实，不要求应用作者手动拼装 |
| viewInstanceId、bindingVersion | 保留其现有实例与绑定失效语义 |
| acquireToolSource | 观察与调用的来源校验基础 |
| BoundActionExecutor | 逐步接入 Observation 和 ToolBinding 登记，保留已有结果与去重行为 |
| 实验 Observation、ActionResult | 按统一行为测试映射到正式契约，不整体复制实验 Kernel |

现有 View-owned Tool Registry 仍有旧 OperationResult handler 形式；迁移适配器必须显式转换，不能把五态结果压回布尔值后再次推断。[Registry](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/core/tool/view-owned-tools.ts)、[执行器](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/core/invocation/bound-action-executor.ts)

## 8 SDK 开发模型

### 8.1 保留组件式入口

保留 createTUIApp、View、常用状态 Hook、Ref Hook 和 View 内工具声明。普通应用作者不需要填写 observationId、bindingVersion 或 Worker 请求 ID。

目标 SDK 的默认规则为：

- View 内工具自动取得当前 ViewInstance，作用范围不由调用者传入的 view_id 决定。
- 公共工具描述可以按类型聚合，具体处理函数属于实例。
- 实例路径、加载状态和可用性放在 View 状态与绑定中，避免让每个实例改变公共 Schema。
- 工具是否可用由显式 enabled 和生命周期决定；展示组件不承担注册权限。
- 说明 View 与状态 View 使用显式语义字段，避免从任意 HTML 字符串推断角色。
- Ref 明确区分快照值与实体定位；列表位置只作为显示或原观察内局部标识。
- 稳定业务 key 能改善列表复用，但不能代替来源绑定或资源版本。

View-local Hook 已存在实验性入口，应该优先把它接入正式执行链。本轮不要求作者同时学习独立的 Tool 模板注册系统。

### 8.2 提交边界

SDK 提供就绪的 View/Ref/Tool 投影，Producer 验证该投影在捕获期间没有变化，再交给 Core 原子提交。MutationObserver 负责提示内容变化，不独自决定一份语义投影是否完整。

显式提交边界、Ref-only 变化、Tool-only 变化、Preact 内部 setState、提交异常和卸载都必须纳入同一组测试。采集过程中版本改变时重试或返回明确未就绪状态，不能发布混合版本。

允许后台加载先发布明确的 loading 状态；依赖数据的工具在 ready 前不可调用。快照一致性不等于应用已完成所有异步业务加载。

### 8.3 公共 API 分层

| 层级 | 目标 |
| --- | --- |
| 常用应用 API | 少量 App、View、Tool、Ref 和状态接口 |
| 高级接入 API | Producer、运行上下文、能力描述、诊断及测试工具 |
| 内部接口 | 注册表、兼容协议和具体 Worker 消息 |

当前组件模式不支持的接口不再以成功返回空值的方式冒充可用。实验 API 标明能力要求；SDK 初始化检查 runtime 提供的契约版本和能力集合。旧入口保留迁移适配，不让同一个调用形式在不同 Runtime 下静默获得不同语义。

Runtime 内部身份可以是结构化标识。公开工具名的字符、长度限制由消费端适配器处理，不能反向定义 Core 的对象身份。

## 9 参数契约与 Schema 方案

采用“一个声明入口，编译得到验证器与公开输入描述”的方式。SDK 中简单的 defineParams 继续可用，作为兼容编译前端；复杂 Schema 通过标准能力适配进入同一内部契约。

Standard Schema 的验证接口与 Standard JSON Schema 的导出接口是两项能力，需分别检查，不能假定实现验证接口就一定能导出 JSON Schema。[验证接口规范](https://standardschema.dev/schema)、[导出接口规范](https://standardschema.dev/json-schema)

内部规范化结果至少包含公开输入 Schema、运行时验证入口和框架分配的契约版本。验证函数留在执行侧，不进入快照。即使公开 Schema 未变，替换验证器或改变不可序列化的校验语义也必须产生新的契约版本。

首个实现支持明确的 JSON 参数子集，复杂特性只有在转换与校验的契约测试通过后才启用。不得将无法导出的类型降为无约束对象。

具体规则：

- 字符串长度使用 minLength/maxLength；数组长度使用 minItems/maxItems。
- 默认值的填充是明确的输入规范化行为，不能因 Schema 含 default 就假定已经填充。
- 公开 Schema 描述调用输入，handler 类型描述验证与转换后的输出。
- 跨 Worker 的输入、Ref 和结果遵守可序列化边界；Date、Map 等需要显式 codec。
- 业务权限与真实资源条件独立于参数 Schema，不强行编码为 JSON Schema。
- Ref 字段的位置、来源类别及解析预算显式声明；首版可以只支持顶层单值，再按需求扩展。
- 相同工具组的公开定义冲突在注册阶段报错，不选第一份、不添加临时后缀隐藏冲突。

JSON Schema 对字符串与数组约束的区别，以及 default 的注释语义，以其规范为依据。[JSON Schema Validation](https://json-schema.org/draft/2020-12/json-schema-validation)

Core 保留校验端口，不内置一套覆盖所有 Schema 特性的自研引擎。默认前端和可选库适配器共同经过契约一致性测试。

## 10 执行结果与资源前置条件

### 10.1 结果语义

| 状态 | 意义 | 后续动作 |
| --- | --- | --- |
| succeeded | 已确认完成 | 读取回执及后续状态 |
| rejected | 前置条件不成立，确认未发生业务副作用；可由执行适配器在实际条件检查时返回 | 根据错误重新观察、调整输入或授权 |
| failed | 业务已给出确定失败，可有部分副作用 | 按 effects 与业务恢复方案处理 |
| accepted | 已受理，仍在进行 | 通过有查询能力的任务适配器取得最终结果 |
| unknown | 已开始但无法确认结果 | 先查询或核对业务状态，不能自动当作未执行 |

Core 首版保留五态协议，但只有提供 operationId 与状态查询契约的适配器才能报告 accepted；本轮不建设通用持久工作流。

现有 M5 的内存回执可作为初始实现。去重范围明确为一个可信执行作用域；记录容量饱和时拒绝新调用，不能淘汰仍承担去重责任的记录。不得通过自动重建执行器来绕过容量。作用域关闭会使旧观察失效，跨进程重启的去重由后续持久适配器另行提供。

### 10.2 按业务操作定义前置条件

| 类型 | 条件示例 | 原子性兑现者 |
| --- | --- | --- |
| 查询 | 原 View/Tool 仍有效；业务可声明额外版本依赖 | 查询适配器 |
| 替换已有资源 | expectedVersion 等于实际版本 | 数据库条件更新或具有明确保证范围的资源适配器 |
| 创建资源 | 目标不存在 | 排他创建、唯一约束等资源原语 |
| 外部命令 | 相同幂等键不会重复受理 | 外部服务或持久业务记录 |

当前 M5 将写入限制为版本化 Entity Ref，是已验证的受控切片。扩展时保留这个路径，给新的操作类别增加显式契约和测试，不能直接删除所有写入保护。

第一个真实写入候选为 IDE 的“目标不存在时创建文件”。现有 createFile 使用排他写入标志，可复用其业务原语。成功与冲突分别验证；创建成功后的崩溃可能仍产生 unknown，排他创建不等于跨崩溃 exactly-once。[文件创建实现](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/demo-apps/aotui-ide/src/core/file-system-service.ts:687)

写入切片应在既有父目录下验证，避免把自动创建父目录的副作用误记为 effects:none。目标目录约束和路径授权由可信业务适配器校验；文件数据未写完的失败也不能笼统报告为无副作用。

对已有文件的版本替换另行验收。当前实现明确只协调使用同一锁协议的写入者，无法阻止任意外部编辑器在最终检查与 rename 之间写入。[现有版本写入边界](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/demo-apps/aotui-ide/src/core/versioned-file-write.ts:50)

## 11 生命周期 存储与诊断

### 11.1 作用域与关闭

资源归属采用 Runtime、App、View、Invocation 的层级。释放函数应幂等；父作用域关闭后不能继续登记新资源。

App 关闭顺序为：停止接受调用、撤销绑定、向运行中的操作发送取消信号、按明确期限等待、请求状态 flush、释放订阅和执行环境。CloseReport 必须反映未完成操作、未确认结果及存储失败。

取消后不能把仍在执行的外部 Promise 从业务风险中删除。Worker 被终止、请求超时和关闭期限到达，都需要按执行阶段判断结果；已经进入业务执行而结果丢失时保留 unknown。

### 11.2 存储接入

usePersistentState 保留其便利性，底层存储从运行上下文注入。读取不存在、读取损坏、权限失败和写入失败应可区分，不能统一恢复为“没有状态”。

UI 状态恢复与关键业务持久化分别说明保证。关闭时 flush 只能作为明确的一种策略。flush 返回可检查的成功/部分失败结果，不能只打印错误后报告整体完成。

首次迁移沿用现有状态键与格式，先加读取适配；引入新格式时使用版本字段和恢复测试，不在同一阶段做不可逆覆盖。

### 11.3 最小诊断模型

提供有界、结构化的生命周期与调用事件：发布版本、绑定注册/撤销、调用开始、拒绝原因、结果、租约与容量状态。支持通过 invocationId 追溯 observationId、ViewInstance 和工具契约版本。

默认记录业务数据摘要，不记录完整文件或任意 Ref payload。调试事件不承担执行去重的权威记录。第一阶段可以提供程序化 inspect 与文本输出，暂不建设完整检查器产品。

## 12 技术选型决策

| 领域 | 本轮选择 | 原因与重新评估条件 |
| --- | --- | --- |
| 语言与构建 | 沿用当前 TypeScript 工程和构建方式 | 先收敛契约，编译器大版本升级单独验证 |
| 默认应用表达 | 保留 Preact SDK 和 DOM Producer | 降低应用迁移成本，已有真实 IDE 使用 |
| 第二 Producer | 普通 TypeScript 与内存数据 | 以最小成本验证无 DOM 的相同行为 |
| Core 生命周期 | 优先复用 Promise、AbortController、显式释放及现有 M5 | 已有可验证基础；若复杂任务组合证明重复成本过高，再比较 Effect 内部适配 |
| 公共 API | 普通对象、Promise、AbortSignal、可判别结果 | 不要求应用作者学习内部执行库 |
| 参数契约 | 统一编译入口，加标准验证/导出能力适配 | 保留简单 API，同时避免多份 Schema 语义 |
| 执行环境 | 现有 Node Worker 作为默认适配器 | Worker 退出核心语义，不在本轮更换运行环境 |
| 状态存储 | 可注入存储，兼容现有本地实现 | 与业务数据库分离，持久调用日志后续单独设计 |
| 验证 | 现有 Vitest/Jest 加共享契约测试和真实 Worker 测试 | 增量建立证据，无需先迁移测试框架 |
| 分发 | 先限制导出与验证产物消费，再决定拆包 | 以真实依赖边界决定包边界 |
| 服务化 | 暂不采用 | 有远程、多语言或独立部署需求时重新评估 RC |

本表调整 RFC 0001 在本轮范围内的实施顺序，不对其候选版本的当前发布状态作新的断言。已有 Effect 实验保留为比较材料；内部选择改变时，公共协议和契约测试必须保持不变。

## 13 分阶段实施计划

S0 至 S5 为本 RFC 的交付阶段，不重命名既有 M1 至 M5 的验证记录。S1 承接 RFC 0002 的语义收敛工作，S2/S3 细化其真实能力接入，S4/S5 承接 SDK 与默认路径迁移。

| 阶段 | 主要交付 | 影响层 | 准出条件 |
| --- | --- | --- | --- |
| S0 冻结语义与证据基线 | 术语映射、默认/实验能力矩阵、可复现代码基线、性能与资源预算 | 契约、测试 | 每项保证有当前路径和验证方式；记录已固定的预算 |
| S1 统一 Core 交互入口 | Observation 发放、绑定登记、Scope 内调用、Schema 编译接入、五态结果映射、最小内存 Producer | Core、内部契约 | 原有 Core 测试及新增观察/调用契约全部通过；无 DOM 的发布—观察—调用闭环成立 |
| S2 真实只读纵向切片 | 用隔离 IDE 入口挂载实际 FileDetail 组件，注册一个本地只读工具 | SDK、DOM Producer、Worker、IDE | 双文件目标隔离、同名重挂拒绝、Ref/Tool-only 更新、真实 handler 结果正确 |
| S3 真实条件写入切片 | Workspace View 内排他创建文件，绑定真实授权和结果报告 | Core 执行适配、Worker、IDE 服务 | 两请求竞争不会覆盖已有文件；失败/超时/关闭的结果与实际文件状态一致 |
| S4 SDK 和适配器收敛 | 能力协商、公共导出整理、存储注入、迁移文档、第二 Producer | SDK、环境适配器 | 同一契约套件覆盖两种 Producer；示例与产物消费通过 |
| S5 完整应用实例迁移 | IDE 所选完整实例使用统一语义路径，完成兼容退出清单 | Runtime、SDK、IDE | 无混合权威来源、无执行失败回退、完整 IDE 回归及预算通过 |

### 13.1 按能力验证 按应用执行实例切换

现有 captureV2 不能把任意旧 TypeTool 与 View-owned Tool 混成严格 V2 快照。S2 使用独立 AppInstance 的实验入口，复用真实 IDE 组件和业务服务，只挂载已经迁移的 View/Tool。它不与默认 IDE 共用一个快照权威或重复注册同一对外目标。

该入口验证真实 SDK、DOM、Worker 和业务服务，尚不代表整个 IDE 已切换。后续逐步扩大这个入口的功能，直到完整应用实例满足 S5。不要为了实现单工具切换而给 V2 偷加未定义的旧 handler 旁路。

模式在 AppInstance 启动时确定：

| 模式 | 观察与执行依据 |
| --- | --- |
| legacy | 旧契约，明确保留兼容行为 |
| observe | 旧路径仍为权威，新 Core 仅对照发布；不重复执行副作用 |
| semantic | 新 Core 是唯一依据；来源或契约失败就拒绝 |

模式切换必须建立新 AppInstance，撤销旧绑定。现有实验开关在过渡期映射到能力描述与模式，停止继续叠加相互独立的布尔开关。

### 13.2 第一条读取能力

选择 FileDetail View 的诊断读取能力。读取原绑定实例当前已经加载的诊断状态，结果带文件身份和状态版本；该工具明确采用“目标固定、状态可更新”的查询语义。需要读取原观察中的固定值时使用快照值 Ref，不将两种读取方式混为一谈。它验证“同名工具、不同 View、不同 handler”，不要求新建完整 LSP 功能。[现有诊断状态](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/demo-apps/aotui-ide/src/tui/FileDetailContent.tsx:69)

最小演示顺序为：打开 A 与 B 两个真实文件视图，取得观察，调用 A 的诊断工具，关闭 A，再以相同公开 viewId 打开 C；旧调用必须拒绝，B 仍能正常调用。该流程通过 Runtime 调用接口驱动，不依赖模型调用。

### 13.3 外部消费端的接入边界

本 RFC 不修改 Agent Driver。SDK/Runtime 的观察与调用协议先由确定性的集成调用方验证。现有消费端若不能携带原始 observationId 和 bindingId，只能继续使用明确标识的兼容入口。

S5 表示完整应用实例在 SDK/Runtime 链路中可运行，不自动表示当前产品的全部模型调用已经遵守新契约。将 semantic 模式设为该产品默认值，还需要单独证明其消费端能往返传递来源绑定；这项集成不由缺少来源的 latest 查询替代。

## 14 验证与验收

| 测试层 | 必须覆盖 | 判断依据 |
| --- | --- | --- |
| Core 契约 | 同名重挂、列表重排、工具禁用、原始 Ref、过期、容量、并发重复调用 | 对象身份与业务后置状态，不只比对文本 |
| Schema 契约 | 必填、范围、枚举、数组、默认值、转换、Ref 字段、验证器更换 | 导出描述和执行规则一致，非法契约在注册阶段拒绝 |
| Producer 一致性 | DOM 与普通 TypeScript Producer | 对相同业务变更遵守相同不变量；不要求文本逐字相同 |
| SDK 提交 | Ref-only、Tool-only、异步状态、渲染异常、卸载重挂 | 不发布混合版本或幽灵工具 |
| Worker 生命周期 | 延迟响应、乱序消息、关闭、终止、运行中 I/O | 旧实例不能更新新实例；结果不虚报 |
| IDE 真实切片 | 两个 FileDetail、诊断读取、条件创建 | handler 目标正确、已有文件不被覆盖、失败可解释 |
| 存储 | 读取损坏、写入失败、部分 flush、格式迁移 | 失败向上传递，旧数据可恢复 |
| 发布产物 | 干净临时目录安装打包产物 | 公开入口、类型和 Worker 路径可用，不依赖相邻源码/开发别名 |

为时序测试使用可控时钟和明确屏障，避免依赖随意 sleep。对重排、卸载、重挂、禁用和重试生成可重放的操作序列；保存失败种子与实际执行目标。

S0 固定小型、典型和容量边缘三种工作负载，记录 View/Ref/Tool 数量及序列化大小。比较发布 p50/p95、调用路由延迟、保留内存、关闭后资源数量。Shadow 双写成本与 semantic 稳态成本分开统计；默认切换前必须通过已固定预算。

预算值来自当前真实 IDE 工作负载基线，不能在回归后自动调宽。资源上限必须覆盖当前快照、历史、租约、Observation、调用记录及诊断；“历史有界”不能代替总资源有界。

所有新增保证要有对应通过的测试。现有 Core 测试通过不等于本文全部阶段已完成，文档中的目标 API 也不纳入已支持列表。

## 15 兼容 回退与发布

兼容层只转换旧协议，不拥有第二套新契约解释权。严格路径中一旦发现来源无效，不得回退调用旧 handler。

回退针对未来的新调用和新 AppInstance，不重放已执行或结果未知的写操作。切换前先停止接收、撤销旧绑定并处理运行中调用；必要时查询业务状态。业务已经发生的修改不会因切回旧版本自动撤销。

SDK 发布时明确稳定、实验和废弃入口。删除旧 API 前须满足：迁移示例可运行、参考应用迁移完成、产物消费通过、剩余依赖清单有结论。日历期限可以辅助管理，不能替代这些准出条件。

只有内部 Core 边界、两种 Producer 和真实应用链路都稳定后，才评估独立 Core 包。独立包的公共类型不得携带 DOM、Worker 或模型厂商类型；已有组合包可以继续提供便利入口。

## 16 风险与应对

| 风险 | 应对与停止条件 |
| --- | --- |
| 新 Core 永久停留在 Shadow | 每阶段都要求真实执行依据迁移；S2 完成前不继续扩展一批新抽象 |
| 同一 App 中混用两套绑定 | 应用执行实例级模式；隔离切片验证，不放宽 V2 来源要求 |
| 严格规则造成频繁过期 | 区分内容修订、绑定修订和资源版本；通过无关更新测试控制误失效 |
| 观察和回执占用过多内存 | 容量、期限和拒绝策略显式化；不淘汰仍承担去重责任的记录 |
| 业务版本校验被误认为原子写入 | 真实资源条件操作测试；文档注明文件系统与合作写入者边界 |
| SDK API 继续增加 | 优先收敛现有入口；新增公共抽象必须由真实应用案例证明必要 |
| 权限检查与执行之间发生变化 | 执行边界重新校验；资源层事务或能力校验负责最终授权 |
| 依赖升级拖慢语义迁移 | 独立升级记录，公共契约与行为套件保持稳定 |
| 产品消费端尚未携带来源绑定 | 保持兼容入口标签，另立接入门槛，不宣称完整产品切换完成 |

## 17 评审决策清单

接受本 RFC 意味着确认以下方向，具体实现按阶段提交：

1. 选择 RD，复用现有 Core，保留 Preact 默认开发模型。
2. Core 维护观察、引用、绑定和执行结果的唯一语义，环境实现通过端口接入。
3. 公共术语统一为 Tool，Observation 作为来源切片；实验术语通过映射收敛。
4. 优先完成只读 IDE 切片，再验证条件创建；不先进行整体 Runtime 重写。
5. 采用按能力验证、按应用执行实例切换，严格执行不回退旧 handler。
6. 参数定义通过统一编译入口连接执行校验与公开描述。
7. 本轮沿用现有技术栈，Effect 等内部实现调整与大版本升级独立评估。
8. 当前消费端未能传递来源绑定之前，不把 SDK/Runtime 的验收扩大为完整产品链的验收。

实施前需要在 S0 具体确定的是资源预算、性能阈值、首版 Schema 支持清单与兼容入口清单。这些参数不改变已选架构；若无法满足核心不变量或现有 Producer 的提交一致性，则停止默认迁移并重新评审该部分设计。

