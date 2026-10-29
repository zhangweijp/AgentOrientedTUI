# AOTUI SDK / Runtime 激进清理与内核收敛计划

**状态：实施计划；尚未执行代码删除。**  
**依据：2026-10-28 本轮读取的实际工作树，而不是仅依据历史分析。**  
**项目：`/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI`**  
**本轮读取时 HEAD：`789ef07cb18084d97b0476c1ffc234ae0b9319f0`。工作树包含大量已暂存、未暂存和未跟踪变更，HEAD 本身不能复现此次分析对象。**

## 0. 总体决定

采用“保留闭包”方法：先列明正式能力和入口，从它们追踪必要实现；无法证明服务于正式能力的实现默认删除。已有 export、自带测试、历史 RFC、以后可能使用，都不单独构成保留理由。

最终目标：**一套 Semantic 状态来源、一套 Observation/Binding 调用规则、一套应用生命周期、一套默认 SDK 声明方式。** 不设长期 legacy 包、不保留旧入口自动回退、不建立实验代码收藏目录。

这不是重新开发框架。继续使用已接受的 Preact 默认 authoring 和现有 Core；不用这次清理建设 CLI、新 DSL、通用任务调度、跨业务事务、自动业务刷新或新的插件体系。

**删除顺序必须服从依赖，删除决定不因迁移成本而无限延期。** 有实际调用的多余机制，要迁移调用方后删除；必要保证不能以“代码量大”为由删除。

## 1. 基线、范围与一次性门槛

### 1.1 本轮确认的现状

- 默认 Host 已使用 `SemanticAOTUIDrivenSource`。其 `getContext()` 将 Messages、Tools、执行绑定和 release 绑定在一次上下文内，不再走旧 `acquireSnapshot()/execute()`。[E1、E2]
- IDE 默认导出已经是 scoped 实现；仍保留显式 legacy 分支。[E8]
- Worker 仍发送 legacy Fragment 和 Semantic Draft 两路消息。主线程 `SNAPSHOT_PREPARED` 分支接纳 Draft，但更新通知仍在 `SNAPSHOT_FRAGMENT` 分支触发。**下线 legacy 前必须转移通知职责。**[E3]
- Semantic Source 内仍有 `compatibilityContext/compatibilityPending` 以及分离的 `getMessages/getTools/executeTool` 兼容入口。[E2]
- SDK 仍同时维护 type-wide 与 View-local Tool，空参数只读还会走 ordinary-v1，部分 Ref 走 snapshot-value-v1。[E4]
- `view-tool-invocation-v1.ts` 是现行多种协议共用的捕获/校验工具，不能按名字整文件删除。[E5]
- Token Monitor 仍真实使用 `useLLMOutputChannel`。[E6]

本轮简单文件统计：Runtime `src` 中 359 个相关源码文件，164 个按命名/目录识别的测试文件，另外 195 个文件合计 30,987 行；SDK 分别为 53、18、35 个，另外文件合计 3,931 行。“另外文件”包含类型和夹具，不等同于纯生产代码。统计不覆盖包外测试，不作为削减百分比承诺。

### 1.2 范围

主范围：`runtime/src`、`sdk/src`、两包导出/配置/依赖/测试/当前文档。

关联范围仅限解除依赖所需修改：Host/Driver 的接入类型和调用点、IDE/Terminal/Browser/Token Monitor 的 SDK 调用、构建和验证脚本、应用构建 Skill 文档。不得借此重写其他模块内部业务。

### 1.3 门槛

- G0：冻结当前真实工作树与测试基线。
- G1：项目所有者确认新 Semantic 路径通过本人测试验收。现有验证文档与历史自动化结果不能替代 G1。
- G2：每批清理通过该批保留契约的构建/测试。
- G3：最终从新产物完成默认宿主、真实 Worker、外部安装消费和资源释放验证。

G1 是既定退出条件，不在验收后反复要求同一决定的额外批准。当前可先准备清单和可回滚的孤立清理补丁；默认产品路径的正式下线以 G1 为前提。

### 1.4 工作树安全

先记录 HEAD、暂存 diff、未暂存 diff，以及本次相关未跟踪源码的内容/哈希。仅建立 Git tag 不足以保存当前状态。以经过范围检查的检查点或独立副本实施；不自动提交用户工作。

不使用 `git reset --hard`、`git clean -fdx` 或整仓目录通配删除。不改变用户 HOME、配置、数据库、真实工作区、凭据、运行中应用数据。回滚代码不等于回滚已经发生的文件/数据库效果。

## 2. 必须保留的最小能力

这里保留的是能力及其唯一实现，不保证每个旧类名、层级、文件名都保留。

| 能力 | 主要现行位置 | 不可删除的原因 |
|---|---|---|
| 不可变 Semantic Snapshot、版本和来源保留 | `core/snapshot/{store,json,types,v2-validator}.ts` | 每次观察需要完整、稳定、可验证的来源 |
| App/View 实例身份与 ToolBinding 版本 | `core/tool/view-owned-tools.ts` | 旧调用不能作用于同名新实例 |
| Observation 选择、投影与执行授权 | `core/invocation/observation-registry.ts`、`scoped-interaction.ts` | 可见与可执行是不同事实，需执行前复核 |
| 同 Scope 调用去重、请求冲突与有界收据 | `invocation-ledger.ts`、`invocation-outcome.ts` | 不重复进入业务，不把 unknown 当失败重试 |
| 普通参数和快照值 Ref 的规范合同 | `ordinary-parameter-*`、`snapshot-value-*` | 模型描述、参数验证和引用来源一致 |
| 提交阶段与投影就绪协调 | `core/projection/coordinator.ts`、SDK 提交 Hook | 不从未完成的组件注册中构造可执行来源 |
| Node Worker 所有权、IPC、错误和实际退出监督 | `worker-host/pool/sandbox`、Worker runtime | 超时、请求终止、实际退出不能混同 |
| App/Desktop/Runtime 停止准入与关闭 | Manager/Desktop/Kernel、`close-operation.ts` | 等待真实工作；失败后仍清理；旧回调不影响新对象 |
| 托管状态与存储适配 | `core/persistence`、storage adapter/proxy/session | IDE 等当前应用依赖；保留地址/修订/恢复/flush 和资源释放 |
| Preact 组件渲染及 DOM→Markdown 必需转换 | SDK factory/View、Producer、必要转换器 | 当前正式应用依赖；Semantic 不等于无需 DOM |
| Semantic 更新信号、Context release、动态能力过滤 | Semantic Source、capability policy、SignalBus | 数据变化能唤醒 Agent，Context 完成后不会无界保留 |
| App 发现、安装、打开、关闭和现行输出通道 | AppRegistry、AppManager、LLM channel | Host 多应用和 Token Monitor 的真实功能 |
| 已接受的纯 TypeScript Producer 消费方式 | Core 公共入口及最小双 Producer 测试 | 验证 Core 不依赖 Preact/DOM/Worker |

容量上限、超限拒绝、只读对象捕获、存储错误、未知结果、实际资源结束等都继续保留。不要通过放宽预算、静默截断或默认允许权限来让清理测试变绿。

### 两个特别边界

1. 只呈现一个最新 View，不等于立即删除所有旧 Snapshot。活跃 Context 仍需要持有其原始观察的有界来源。默认 scope-owner 生命周期不能退化成思考 30 秒即过期；显式 TTL 模式和结果保留 TTL 也不能混同。[E1]
2. `OperationProvider` 当前承担 Core `accepted` 的归属证明及有界查询，不是简单孤立文件。本计划保留这个最小现行契约与 `readReceipt()`；不新增跨轮查询服务、轮询调度或持久任务。删除这段机制需要重定义 accepted，本轮不把这种语义改写伪装成死代码清理。[E9]

## 3. 逐类删除清单

标记说明：D＝删除；M→D＝迁移依赖后删除；R＝保留唯一实现并收敛；X＝从必需内核移出到已有责任层。以下均是计划动作，不表示删除已执行。

### 3.1 孤立实现、空壳和重复便利 API

| ID | 对象 | 动作 | 必要联动 |
|---|---|---|---|
| D01 | `runtime/src/engine/view/snapshot/builder.ts` | D | 删除重导出、专属测试；现行消息呈现不使用它 |
| D02 | Kernel 的 `transformer` 成员与工厂中无效注入 | D | 修改 `factory/createKernel.ts`、构造测试；不是删 Worker 内纯转换器 |
| D03 | `runtime/src/adapters/session/` | D | 删除私有 barrel 与废弃会话类型，不引入新 Session 框架 |
| D04 | `core/invocation/bound-action-executor.ts` | D | 删除专属实验测试；保留仍被 scoped 调用的 ledger |
| D05 | `engine/core/operation-log-buffer.ts` | D | 当前扫描没有生产导入，仅专属测试；保留仍使用的 logger |
| D06 | `worker-runtime/app-kernel/view-tree.ts` | D | 删除旧 tree 类型、barrel 及纯旧测试；不连带删除现行 View 身份 |
| D07 | `sdk/src/hooks/persistence-manager.ts` | D | 删除根导出及 throw-only 过渡测试 |
| D08 | `useMountableViewRegistry/useDynamicViewRegistry` | D | 同删 View 上的抛错字段、Context 字段及类型 |
| D09 | `useResourceRef` 别名 | D | 现行声明统一 `useDataRef/useArrayRef`；Preact `useRef` 保留 |
| D10 | `sdk/src/hooks/useSignalStore.ts` | D | 当前扫描只见导出；移除其类型和独占的 `@preact/signals` 依赖 |
| D11 | SDK 纯通用命名校验工具的公共再导出 | D | `utils/validation.ts` 当前仅根导出与测试；Runtime 必需身份验证不删 |
| D12 | `core/snapshot/workspace.ts` 旧 composer | D | 当前只见内层 barrel；保留 Semantic Source 真实多 App 聚合 |

本轮 AST 检查解析了静态 import/export 及字符串字面量 dynamic import/require；搜索排除构建、依赖和历史交付目录。它没有证明任意外部消费者或计算得到的动态路径不存在。实施前还应检查 package exports、Worker/manifest 入口、生成脚本和初始化副作用。历史公开身份不改变已批准的大版本删除决定。

### 3.2 旧 Snapshot、IndexMap、执行与系统操作链

| ID | 对象 | 动作 | 完成条件 |
|---|---|---|---|
| M01 | `adapters/aotui-driven-source.ts` 与旧默认 instruction | D | 当前 Host 已使用 Semantic；删除 adapters 旧导出与旧专属测试 |
| M02 | `Kernel.acquireSnapshot/releaseSnapshot/execute/getSystemToolDefinitions` | D | 产品调用只用 Semantic/直接 App 生命周期入口；保留 Core 的 Snapshot lease |
| M03 | `engine/system/registry.ts` 的旧 SnapshotRegistry | D | Kernel 和旧适配器不再持有它 |
| M04 | `engine/system/dispatcher.ts` | D | 不再按任意字符串和当前 IndexMap 猜测 Ref/操作目标 |
| M05 | 旧系统操作 registry、open/close/dismount 操作包装 | D | 保留 Desktop.openApp/closeApp 和 Semantic Source 控制工具 |
| M06 | `engine/view/snapshot/formatter.ts`、templates、旧 StructuredSnapshot 类型 | D | XML/Markdown 呈现来自 Semantic Observation；共享格式工具先迁出 |
| M07 | Desktop/Sandbox/WorkerHost 的 Fragment getter/cache | M→D | 发布通知职责先转移，真实消费者为零 |
| M08 | `SNAPSHOT_FRAGMENT`、`APP_OPERATION/VIEW_OPERATION`、旧 `OPERATION_RESPONSE` | M→D | 新调用通道与 Semantic 发布可以独立完成所有必留场景 |
| M09 | 旧桌面锁 `acquire/release/verify/refreshLock` 及 lock 配置 | D | 已无 Kernel.execute 消费；保留 Scope 并发限制、存储所有权和业务文件合作锁 |
| M10 | `OperationPayload/IndexMap/CachedSnapshot` 等纯旧类型 | D | 逐符号删；不能把现行 `OperationResult` 因名字含 Operation 一并删掉 |

### 3.3 Shadow 转正与发布通道独立

| ID | 对象 | 动作 |
|---|---|---|
| P01 | `SnapshotShadowReceiver` | R：保留 Core 接纳、Scope 创建、关闭；删 legacy 比较/配对/差异计数，重命名为正式接收器 |
| P02 | `DomSnapshotShadowProducer.capture()` V1 分支 | D：保留 V2 捕获，去掉混合/type-wide 自动降级 |
| P03 | 全 App legacy transform、IndexMap 合并、type-tool 元数据导出 | D：保留按 View 的正文与 Ref 投影 |
| P04 | `AOTUI_SNAPSHOT_SHADOW`、显式 shadow 开关和纯双轨诊断 | D：Semantic 成为必需路径，失配明确拒绝 |
| P05 | 原 `exportRefsToIndexMap()` | M→D：改为 Semantic Ref 清单端口；保留其真正导出 View 内 Ref 的功能 |
| P06 | Snapshot V1 类型、validator、兼容分支 | M→D：最终只接受现行结构；共有 JSON/refKey/容量工具迁入保留模块 |

**关键执行顺序：**

1. 先让接收器返回接纳结果：published/unchanged/rejected/health-change 等必要事实。
2. 已接纳的新 Semantic 投影再触发更新通知；状态不可用时保留有界错误与必要唤醒。
3. 保留 `auto/never/manual` 的实际发布/通知区别，直到其使用情况被明确统一；不能把 suppressSignal 一起丢掉。
4. 新投影、Ref-only、Tool-only、空 View 集合、后台更新均验证通过。
5. 最后停止发送 Fragment，删除 Fragment 接收缓存和比较统计。

不能先删旧消息，再用一个定时轮询补救。也不能保留“shadow 失败不影响主路径”的吞错策略，因为此时 Semantic 已是唯一主路径。

结构版本号不因为去掉旧实现就重置。内部可以统一类型名称，但保持明确可拒绝不兼容数据的协议版本。

### 3.4 单一 View 所有权与 SDK Tool 路径

| ID | 对象 | 动作 | 保留行为 |
|---|---|---|---|
| S01 | `useViewTypeTool` type-wide 重载与 `isLegacy` 分支 | D | 只保留当前 View-local 声明方式；不需要为清理额外改主 Hook 名称 |
| S02 | AppKernel.typeTools、callTypeTool、legacy Ref resolver | D | 所有调用按 ViewInstance/Binding 路由 |
| S03 | `createInlineView`、operationsRef、旧 IView registry | M→D | 从 `<View>` 移除第二套操作注册；保留真实挂载时的 owned identity、Ref、Tool 和 onClose 行为 |
| S04 | `ViewRegistry`、renderViewTree、data-view-tree、markDirty 对旧 tree 的刷新 | M→D | Context 的 dirty/更新通知若仍需要，应接到投影端口，不再渲染旧 tree |
| S05 | SDK Factory.create() throw-only、callable factory、view factory | M→D | `createTUIApp` 直接满足唯一组件 Factory；更新 AppRegistry 检测及 manifest 生成脚本 |
| S06 | `use-view-selector` 的缓存/比较包装 | M→D | 内部调用简化为必需 Context 读取与错误提示，不新建细粒度响应式框架 |
| S07 | 重复 AppConfig Context/Hook | M→D | 保留 `useAppConfig/useAppEnv` 的实际配置获取；将实现收敛到一个权威 Context |
| S08 | 根入口暴露的内部 registry/adapter/factory | D 公共导出；按引用决定实现 | App 开发者不用的底层装配不在根入口；不通过新建大量 subpath 保存旧 API |

ViewRegistry 与 createInlineView **当前仍被真实调用**。删除理由是 Semantic 已有一套 View 所有权与调用路径，可以在完成迁移后消除第二套；它们不能按“现在零引用”处理。

### 3.5 工具协议与 schema：五种模式收敛成两种必要参数语义

最终保留：

- 普通参数调用：现行 ordinary-v2。
- 只读快照值 Ref 参数调用：现行 snapshot-value-v2。

这是一个来源绑定调用模型的两类参数处理，不重新设计一套通用消息协议。

| ID | 删除对象 | 先完成什么 |
|---|---|---|
| T01 | ordinary-v1 适配器/Worker handler/SDK wrapper | 空参数只读调用迁到 ordinary-v2，仍显式只读；不得通过改成 mutating 来逃避迁移 |
| T02 | snapshot-value-v1 传输与 SDK wrapper | 原观察值、同 View 归属、只读不可变与普通参数组合均迁到 Ref V2 |
| T03 | `experimental_useReadOnlyTool` 的平行注册实现 | 将其必要 Ref V2 编译/只读类型能力合入唯一 View-local 声明路径；迁移调用后删除旧 Hook，不留 alias |
| T04 | `sdk/utils/validateArgs.ts` 和手写 legacy Schema 转换 | 所有正式调用使用同一规范参数合同；先迁出任何真实共享校验 |
| T05 | AppKernel/WorkerHost 中 `experimentalInteractionModes` 等实验资格开关 | 用正式能力配置/默认支持集替代；保留 Worker ACK、实例与实际 callable 资格验证 |
| T06 | `view-tool-invocation-v1.ts` 旧文件名和混合职责 | 迁出仍由 V2 和 lifecycle 使用的有界捕获/终态校验到正式共用模块，再删旧文件 |

`refSource: 'snapshot-value-v1'` 可能表示引用来源语义，不等于 V1 传输。state-session-v1 等仍有效协议同理。**不得全局替换或删除所有含 v1 的字符串。**

原始参数声明、模型公开 schema、执行校验、合同指纹继续由同一合同产生。保持现行“不自动注入 default”、额外字段策略、有限 JSON 捕获及深度/大小限制，不在清理时改变参数业务行为。

### 3.6 删掉框架中的业务专用通道

| ID | 对象 | 最终决定 |
|---|---|---|
| B01 | `WorkerHost.executeVersionedFileReplace()` 及专用 preflight | 删除；框架不拥有 IDE 文件写入 |
| B02 | `unobservedFileVersions/activeFileReplacements/fileReplacementWaiters` 等专用状态 | 随 B01 删除其独占字段、报告字段和分支；通用在途调用、存储 I/O 与应用 close 等待保留 |
| B03 | `validateSnapshotValueRefTool/executeSnapshotValueRefTool/executeReadOnlyViewTool` 旧旁路 | 删除；只允许 Scope 来源绑定调用 |
| B04 | SDK `useEntityRef`、旧 entity File mutation 切片 | 删除该实验 authoring/执行链；业务自行维护实体 ID、版本和条件写入 |
| B05 | `create-if-absent-v1` Core/IPC/SDK 专用通道 | 迁移后删除；已有业务改用普通工具 + 应用资源 adapter |
| B06 | `experimental_useCreateIfAbsentTool` 与专用 outcome 类型 | 迁移 WorkspaceCreateView 后删除；结果映射只做一次，测试其保真 |

B05 不是删除独占创建的业务能力。`demo-apps/aotui-ide/src/core/conditional-file-create.ts` 和业务工作区约束继续由 IDE 拥有。

现行创建结果必须逐项映射：成功保持成功；已知失败 none/partial 保持对应副作用事实；unknown 保持 unknown，不补填 effects:none；入口前拒绝仍为未进入。已写成功但展示失败仍保留已知写入成功。不改变“父目录必须已存在”“不覆盖已有文件”等业务规则。[E8]

这些属于内部路径/公共 API 的实质缩减，必须用实际文件测试证明等价业务行为，不能仅删相关测试。App-owned 文件校验、合作锁和 LSP 清理绝不因为框架专用通道退出而删除。

`versioned-ref-declarations.ts` 也不能仅凭名字删除：其中若服务于正式 Ref V2 参数校验，相关功能继续保留。

### 3.7 生命周期、宿主和类型整理

- 删除 `WorkerAppHostService` 这套没有正式消费者的旧装配包装，删除 `DesktopOptions.appHostService` 双重关闭路径与专属类型；保留 AppManager/WorkerHost 唯一真实所有权链。
- 删除 `SignalServiceImpl` 旧包装及只为它存在的注入分支；保留 SignalBus/订阅释放。
- 删除旧 `ViewManager`、ViewLink/mountByLink、纯旧 VIEW_DISMOUNT 和 REQUEST_MOUNT/DISMOUNT_CHILD 通道。业务 View 通过组件状态打开/关闭；仍在使用的 onClose 行为迁移后保留。
- 移除旧 Factory 对象/函数/app 实例 fallback、`__AOTUI_APP_CONFIG__` 全局回退、legacy persistence 的 timeout-success 路径。
- managed 生命周期能力成为正式合同；不支持的 SDK/Worker 明确拒绝。不能把缺失 ACK 当作受管理成功。
- 删除仅为旧注入对象缺少 beginClose/beginShutdown/report 而存在的 fallback。测试替身实现正式窄接口，不维持假旧对象支路。
- 保留构造/安装过程中的迟到对象清理、共享池归属、实际 exit、底层 I/O 结束、停止准入和关闭观察者 deadline 的区分。
- `experimental_useAppLifecycle` 收敛为正式 `useAppLifecycle`，回调继续可选；没有外部资源的应用不用被迫写空回调。
- `experimentalCreateAppScope` 收敛为正式 `createAppScope`。只改名不改变 Scope 权限、所有权和容量。
- 业务清理失败即使 Worker 已退出也仍是失败；resourcesReleased 与 hasFailures 等事实不能为了简化报告而混成单一 boolean。

### 3.8 Semantic Source 自身也要清理

删除 `compatibilityContext/compatibilityPending/compatibility()` 和旧分离方法。保留唯一 `getContext()` + release 用法。

当前它实现 `IDrivenSource`，因此删除时需要关联修正 Source 类型与少量调用点：让 Context 型 Source 无需伪造旧方法；既有其他 Source 不必在本次全部重写。Driver 的现行 getContext 调度继续复用。不能用空函数或每次隐式建立新 Context 来替代旧兼容代码。[E2]

保留 `setEnabled/setAppEnabled/onUpdate/dispose`、真实 App 生命周期工具、可执行能力过滤、Context 释放后的拒绝、同轮原始绑定和多 App 聚合。不新加通用分页、上下文排序或跨轮查询服务。

### 3.9 依赖、发布面、历史和实验目录

依赖的最终去留由移除后的真实 import、类型声明链、测试环境和干净消费决定：

- `sdk`：删除随 useSignalStore 退出的 `@preact/signals`；没有真实生产 import 的 LinkeDOM 不继续作为 SDK production dependency。
- `runtime`：LinkeDOM 保留在 Worker 适配；当前源码未发现 happy-dom、preact-render-to-string、zod 等正式生产 import，应删或移到真正需要的 devDependency。
- 旧 AOTUI adapter 删除后，Runtime 的直接 `ai` 依赖重新核对；**不能承诺删除所有模型相关安装依赖**，当前 Semantic Source 的 `jsonSchema` 仍来自 `@aotui/agent-driver-v2`。
- `@types/json-schema` 是否可删，必须用 `skipLibCheck:false` 的安装消费者验证，不用源码无 import 作结论。
- Runtime 的 AppRegistry、CLI、catalog/安装能力当前有 Host 消费，本轮保留；不因为不属于纯 Core 就删除整个运行宿主。
- `exports` 从大范围 `export *` 收敛为正式 API 清单；实现可内用而不公开。
- 清除已删除代码的 dist 输出、map、d.ts、测试夹具误打包。不能只检查 src。
- 每个实际安装主体保持一份权威 lock。仓库开发 lock 与外部 tar 消费者 npm lock 服务不同目录，不按文件名批量删除。
- 删除已经由正式能力/测试替代的 `experiments/semantic-kernel` 实验包及其独立依赖图；保留其仍独有的必要契约测试作为正式测试后再删。已接受的普通 TS Producer 最小证明保留。
- 已失效的复制源码式迁移文档退出当前开发导航；验收事实、RFC 决策和必要证据先保存到可追溯历史，再移除主树重复代码。当前大量内容未跟踪，不能声称 Git 已经保存了它们。
- 历史签署结果不改写为新清理结果。`.tmp`、数据目录、旧 LowDB 和用户配置不在源码清理授权范围。

## 4. 具体实施批次

每批必须包含代码、类型、测试、文档/示例必要改动；不留“后面再补删”的兼容实现。路径重排和全仓格式化不与行为清理混成一个补丁。

| 批次 | 工作 | 前置 | 本批完成证据 |
|---|---|---|---|
| C00 | 保存工作树基线、保留 API/能力清单、测试矩阵 | 无 | 可复现当前源码；已知失败与跳过有记录 |
| C01 | 删除孤立实现/throw-only API/无消费者便利工具 | C00 | 静态调用/导出消失；必要测试与构建通过 |
| C02 | Semantic 独立发布、提交后通知、失败可见；停发 legacy Fragment | G1、C00 | 无 Fragment 仍能初始观察、后台更新、Ref/Tool-only 更新、空态关闭 |
| C03 | 删除旧 Snapshot/IndexMap/execute/dispatcher/system registry/桌面锁 | C02 | 默认 Host 多 App 与 Core 调用测试通过；旧 API 不再导出 |
| C04 | SDK/AppKernel 单一 View 注册、Factory 和 Context 收敛 | C03 | 真实 mount/unmount/remount、onClose、Ref 注册与 Tool 生命周期通过 |
| C05 | ordinary-v1/ref-v1 调用迁移；单一 authoring、规范 schema | C04 | 空只读、带参普通、Ref V2、错误参数、旧绑定拒绝全部通过 |
| C06 | 移除 pre-Scope 调用、框架文件 CAS/entity/create 专用路径 | C05 | 真实业务写入与未知效果映射保持；框架不再持有文件专用状态 |
| C07 | 删除旧生命周期/Factory/注入对象 fallback，实验能力转正 | C04–C06 | 停止、失败清理、迟到初始化、物理退出与持久化故障测试通过 |
| C08 | 移除 Semantic Source 分离方法兼容缓存，收窄 exports/类型 | C03–C07 | Context 唯一接入；关联 Host/Driver/应用编译通过 |
| C09 | 清依赖、干净产物、当前文档/Skill/示例和实验目录 | C08 | 新 tar 无旧实现/测试泄漏；文档所有默认示例可运行 |
| C10 | 全量剩余测试、真实 Worker/Host/IDE/外部消费者验证 | C09 | 完整新报告，性能/资源无越线；无旧回退 |

可以把 C01 中真正独立的项并行准备；C02 是旧发布链退出的硬依赖。C05/C06 切换协议必须同时覆盖 SDK、Runtime 和消费者，不能先发布半个组合。

## 5. 五个最容易误删的依赖

### 5.1 更新通知

当前 Semantic Snapshot 接纳与 Driver 唤醒不是同一条消息路径。先把唤醒转到成功接纳的 Semantic 结果，再删除 Fragment。必须测试后台变化，不只测试工具调用后主动读取。[E3]

### 5.2 Markdown 与 Ref 转换

`transformElement()`、View fragment extractor、Ref 导出仍被 Semantic Producer 使用。只删除其 IndexMap/旧 Operation/旧 ViewLink 职责；必要的正文、代码块、列表、Ref 标记和工具展示不受损。DOM 不承担执行权限，ToolBinding 继续是执行来源。

### 5.3 双重 View 注册

`<View>` 当前既创建 owned View identity，也创建 inline IView 并向旧 registry 注册。后者可以退出，但需要保留实际挂载/卸载顺序、上下文元数据、Ref 清理、Tool 释放与 onClose。不能把整个 View Hook 清空。[E7]

### 5.4 通用协议捕获

V2 与 app-lifecycle 仍导入名为 `view-tool-invocation-v1.ts` 的通用校验。先抽出原有 shared logic，不削弱字段校验、身份检查和字节预算。[E5]

### 5.5 同 Scope 收据与业务任务

`readReceipt()` 并非无人使用的模型轮询：本地 Controller 和 Core 消费者可以在原 Scope 内使用它。保留有限读取/去重与 accepted 归属机制；标准 Source 不新增跨轮“读取任意旧收据”。业务长期任务仍由应用 View 表达。[E1、E9]

## 6. 测试迁移规则

**允许删测试实现，不允许丢失仍保留能力的证明。** 为每个原测试归类：

- 纯退出接口/类/旧 wire 兼容测试：删除。
- 语义仍然有效、只是调用旧入口：迁移到唯一新入口。
- 不同阶段重复证明同一分支：合并，留下最小充分覆盖。
- 身份、权限、容量、收据、生命周期、外部消费的反例：必须保留。
- 修复过真实回归的测试：除非该能力整体退出，否则迁移保留。

禁止扩大 test exclude 来隐藏失败，禁止增加 skip/only、放大 timeout/预算来掩盖回归，禁止以测试数量下降为清理成功依据。测试中为了证明旧 API 不存在而出现旧符号字符串，不属于生产残留。

### 6.1 不变量验收矩阵

| ID | 场景 | 必须证明 |
|---|---|---|
| I01 | 未打开文件 | 不暴露已打开文件的编辑 Binding |
| I02 | 打开 test.txt | 内容、Tool schema 与目标来自同一 Observation |
| I03 | 编辑后下一次观察 | 只有一个最新 FileDetail 当前快照，正文不作为普通操作结果重复返回 |
| I04 | 关闭再同 ID 重开 | 原 ViewInstance/Binding 不重绑；旧调用拒绝 |
| I05 | Tool 停用/合同更新 | 旧 Binding 拒绝；不能靠猜工具名调用 |
| I06 | 无关 View/面板变化 | 不无谓撤销未变化的合法绑定 |
| I07 | 31 秒思考、Context 释放 | 默认 owner lifetime 继续可用；显式 release 后拒绝 |
| I08 | 300 轮上下文 | Observation/Scope 按所有权释放，不因固定 Scope 去重表累积耗尽 |
| I09 | Ref-only/Tool-only/后台 DOM 变化 | 无 legacy Fragment 仍发布更新且按策略通知 |
| I10 | 初始空/最后 View 关闭 | 合法空 Semantic 状态；不保留幽灵能力 |
| I11 | 五种 outcome/失败副作用 | rejected、failed-none、partial、accepted、unknown 不被误报为成功或安全重试 |
| I12 | 请求重复或冲突 | 同 Scope 同请求不二次进入；同 ID 不同请求拒绝 |
| I13 | 参数与引用 | 空只读、普通约束、额外字段、Ref 归属及原始快照值一致 |
| I14 | 发布/传输失败 | 不把写入不确定性清零，不自动重放 |
| I15 | stop/close 与迟到工作 | 停止准入；实际 pending/I/O/子资源的责任不提前消失 |
| I16 | 生命周期故障 | flush/unmount/close/release 失败分别保留；仍尝试独立清理 |
| I17 | Worker 复用 | 旧 lease/旧 listener/旧 App 回调不能影响新实例 |
| I18 | 容量与纯 Core | 超限明确拒绝；ES2022、无 Node/DOM 类型消费者仍成立 |
| I19 | 包与 CLI/宿主 | 使用新 tar 严格类型检查；默认 ./run.sh 无旧路由依赖 |
| I20 | 业务 adapter | IDE 真实文件冲突/独占创建/LSP；Terminal 后台进度；Browser；Token Monitor 均不丢能力 |

I03 保留/验证当前已验收流程的读后行为，不借此声称任意外部业务、任意异步副作用都由框架提供事务一致性。未被当前实现承诺的新能力另列需求，不通过清理偷偷扩张内核职责。

### 6.2 已确认存在的验证入口

以下是实施时的入口，不是本轮执行记录。需要在隔离工作副本中构建，并按脚本要求提供新的临时结果/fixture 路径。

```bash
# 当前依赖方向；清理改变依赖后据实调整，不使用旧 dist 凑通过。
pnpm -C agent-driver-v2 run build
pnpm -C runtime run build
pnpm -C sdk run build
pnpm -C demo-apps/aotui-ide run build
pnpm -C demo-apps/terminal-app run build
pnpm -C demo-apps/lite-browser-app run build
pnpm -C demo-apps/token-monitor-app run build
pnpm -C host run build

# 剩余正式测试：删的是退出契约，不是给旧测试加 skip。
pnpm -C runtime exec vitest run
pnpm -C sdk exec vitest run
pnpm -C host exec tsx test/semantic-host.e2e.ts
```

还需运行/迁移：

- `runtime/tests/w10-package-consumer.mjs` 的新包消费能力。旧版本兼容矩阵 `w10-artifact-compat.mjs` 不再作为保持旧 API 的门槛；保留有效测试逻辑后移除旧矩阵。
- `demo-apps/aotui-ide/tests/scoped-ide.e2e.mjs`、edges/capacity/close/performance 与真实 scoped-lsp 测试。
- `host/test/semantic-host-llm.e2e.ts` 的真实模型验证：只在已有授权配置下运行，报告中不含凭据；自动化事实不冒充项目所有者验收。
- Token Monitor 的输出事件消费；它不属于无消费者代码。
- 新包消费者使用 `skipLibCheck:false`，Core 使用 ES2022-only / `types:[]` 验证；不借工作区 alias、旧 tar 或旧 node_modules 通过。
- 性能采用同机同负载的已冻结预算，不自行增加上限；记录初始化、observe、invoke、关闭、长轮次内存与 Worker 数。

## 7. 结果交付与完成定义

每个删除项有一条任务记录：ID、当前路径/符号、决定、保留替代、前置批次、消费者、测试去向和结果证据。不得以“文件删了但类型以后再处理”关闭任务。

最终交付：

1. 删除清单及逐项实际结果。
2. 正式 API/能力清单和不再支持的旧入口清单。
3. 迁移后的 Runtime/SDK/应用/Host 测试矩阵与真实结果。
4. 新 tar、manifest、lock、完整性信息与空目录消费结果。
5. 当前 SDK 使用文档和应用开发 Skill；旧示例退出默认检索入口。
6. 可回滚源码检查点与不涉及业务数据回滚的明确说明。

### 必须归零

生产源码中的旧适配器、旧 SnapshotRegistry/Dispatcher、旧按名称 execute、Fragment IPC、type-wide Tool、第二套 IView 操作路由、ordinary/ref V1 旧执行通道、create/entity 专用实验执行、throw-only API、过渡 alias、只为旧二进制/旧注入对象存在的 fallback，以及相应发布产物。

“归零”针对已决定删除的实现，不包括历史验收记录中的名字、负向测试里的禁止符号、现行 state-session-v1 等不同协议的合法版本号。

### 必须维持

当前 Semantic 的身份/来源/授权/容量/释放不变量；动态 View/Tool；XML+Markdown User Message；同一当前 View 只呈现最新内容；已接受的业务应用与纯 TS Core 消费方式；错误和副作用事实保真。

不设人为删除行数 KPI，不承诺未测的体积/性能改善。最终成功标准是：**退出机制完全消失，正式能力有唯一清晰实现，调用方无需知道迁移历史。**

## 8. 证据索引与核对范围

下面行号对应本轮工作树，后续实现变化后应使用新行号和新哈希。建议将本计划与实际清理变更分开保存。

- **E1**：`runtime/docs/semantic-host-integration.zh-CN.md:3–5,19–57,61–83,107–117`。当前默认接入、原子 Context、owner lifetime、容量、收据与后台任务边界。对应 `semantic-host-validation-2026-10-28.zh-CN.md:5–7,27–38,79–84` 是已有验证记录，本轮没有重跑其测试。
- **E2**：`runtime/src/adapters/semantic-aotui-driven-source.ts:144–225,253–274,276–307`。同轮观察与绑定、兼容缓存、release/dispose。
- **E3**：`runtime/src/engine/app/worker-host.ts:1464–1519` 与 `runtime/src/worker-runtime/index.ts:972–1119`。仍并行发布 Fragment/Draft，通知仍由 Fragment 触发。
- **E4**：`sdk/src/hooks/useViewTypeTool.ts:92–114,166–196,240–266`；`sdk/src/hooks/useReadOnlyTool.ts:42–104`。多入口分支、ordinary-v1/v2、Ref 路径与提交包装。
- **E5**：`runtime/src/adapters/view-tool-invocation-v1.ts:1–98`，及 AST 导入结果：app-lifecycle、ordinary-v2、ref-v2 等均使用其共享捕获逻辑。
- **E6**：`demo-apps/token-monitor-app/src/tui/TokenMonitorApp.tsx:1,71`。当前真实 LLM 输出通道消费者；SDK/Runtime manifests 是依赖判断输入，不代表发布状态。
- **E7**：`sdk/src/components/View.tsx:125–140,188–208,221–280`；`sdk/src/factory/index.ts:58–76,126–145`。双重 View 注册、Context 残留、旧 callable factory。
- **E8**：`demo-apps/aotui-ide/src/index.ts:1–7`、`src/tui/WorkspaceCreateView.tsx:55–79`、`runtime/src/core/tool/create-if-absent-contract.ts:5–11`。默认 scoped 入口及仍在使用的专用创建调用。
- **E9**：`runtime/src/core/invocation/scoped-interaction.ts:352–368,409–466,530起`。accepted 的 provider 归属与查询；删除 provider 会改变现行语义。
- **E10**：`sdk/src/index.ts:46–77,108–149,183–195`；`sdk/src/hooks/useViewContext.ts:61–73`。当前公共入口的无效/实验/过渡表面。
- **E11**：本轮 TypeScript AST 导入盘点：bound-action-executor、operation-log-buffer 无生产导入；SnapshotBuilder/ViewTree/WorkerAppHostService/useSignalStore 仅定义或 barrel 级引用；createInlineView/ViewRegistry/factory 则仍有实际内部引用。上述结论限定为本次仓库源文件扫描。
- **E12**：`AGENTS.md` 第六节；旧清理计划的兼容限制不再限制验收后的 Breaking Change。

### 核对文件 SHA-256

| 文件 | SHA-256 |
|---|---|
| AGENTS.md | a0365e3e59d9f481dffc9de95bd49acca00e72aa690b4158ca7827c61932ca9a |
| runtime/docs/semantic-host-integration.zh-CN.md | a89b390ca1a54d803b090e28e7a7096affa1e9229dc9e26d0ad7ebf0ff154969 |
| runtime/src/adapters/semantic-aotui-driven-source.ts | e499bafad60e610692bf30e23fcbd3dccf5acd2bdb2babc711308c3a64c2be34 |
| runtime/src/worker-runtime/index.ts | 227a84514f2dd815e4c9c5912b72b62d06ac2a7a93d27419e0564ea8c5188450 |
| runtime/src/engine/app/worker-host.ts | d7f651426bf8d940155a8ca87c7bf6644347300bd3cd737241094fda3baa45a7 |
| sdk/src/hooks/useViewTypeTool.ts | d2e7934a572f5beb20b5d8f2b6f2b69bfdc7b703fa58427911d6df44a2a8169a |
| sdk/src/index.ts | 3a9c146721e1fe7c087ee5f4606325f87c8ed9fbf0367c18261cfb7b2ffc6682 |
| runtime/src/core/invocation/scoped-interaction.ts | 80c99e5239cf81960e56f37dcfe6a739fcceeafac4989c721b60904b42db4ba8 |

**本轮操作范围：读取远端仓库、静态搜索和 AST 导入检查；没有在远端执行构建、安装、测试、提交、移动或删除源码，也没有修改 AGENTS.md。**
