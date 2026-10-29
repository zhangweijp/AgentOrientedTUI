# AOTUI 代码清理兼容接口盘点

盘点日期：2026 年 10 月 7 日。执行起点为 `789ef07cb18084d97b0476c1ffc234ae0b9319f0` 加已有第一轮 42 个已跟踪文件改动；初始补丁 SHA-256 为 `b6b6863f38e57777af093f0989d0cf518482e381a8d3ccb152c000af0c97725d`。

本报告属于 C04，只记录八项接口的现状和后续建议。本轮没有删除这些接口，也没有补实现。检查范围为 Runtime、SDK、Driver、Host 和 Demo Apps 的当前 TypeScript 源码与测试，排除依赖目录和 dist；历史文档只作为线索。仓库内没有调用方，不等于不存在外部使用者。

“包入口”指 package.json 的 exports；“内部导出”指源码文件或内部 barrel 的 export，不能据此认定可以通过 npm 包子路径导入。以下私有字段本身均不是公共导出；需要保护的是关联的构造参数、配置和方法契约。

| 对象 | 后续建议 | 主要依据 |
| --- | --- | --- |
| Desktop.appHostService | 需要另开功能或兼容性设计 | 注入选项仍接受服务，但保存后没有调用 |
| SnapshotBuilder.transformer | 可在下一轮删除字段及默认实例 | 当前类无有状态构造，Builder 不再转换 DOM；可选构造参数须单独保留或制定迁移 |
| SnapshotFormatter.appLogLimit | 需要另开功能或兼容性设计 | 配置文档承诺限制应用日志，当前格式化路径没有使用它 |
| Kernel.transformer | 保留 | Kernel 从包根导出，Transformer 是公共构造函数的第三个位置参数 |
| ViewManager 兼容方法 | 保留 | Desktop 仍委托这些方法，并继续发送状态变化信号 |
| ArrayRefHandle 的泛型参数 | 保留 | 类型从 SDK 包根导出，改变类型实参数量会破坏外部 TypeScript 消费方 |
| useLLMOutputChannel 的 options | 需要另开功能或兼容性设计 | includeHistory 没有实现，但参数和选项类型已公开 |
| useSignalStore 的局部绑定 | 可在下一轮删除绑定，保留读取 | `s.value` 的读取为 effect 建立订阅，不能和变量一起删除 |

**1. Desktop.appHostService**

- 导出路径：[Desktop 与 DesktopOptions](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/core/desktop.ts:18) 在该源码文件导出；Desktop 还经 [core/index.ts](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/core/index.ts:13) 内部导出。`appHostService` 字段是 private，Desktop 和 DesktopOptions 不在 Runtime 包根或当前 exports 子路径中公开。选项所用的 `IAppHostService` 则由 Runtime SPI 导出。
- 当前调用方：源码仅有选项声明、私有字段声明及构造赋值。`new Desktop(id, options)` 仍接受该选项；[DesktopManager.create](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/core/manager.ts:62) 只传 runtimeConfig 和 context。Desktop 测试会直接构造实例，但没有注入 appHostService；Host、SDK、Driver 和 Demo Apps 未找到该选项的实际传入。
- 副作用：构造器读取选项并持有服务引用，没有调用服务的方法，也不负责创建或销毁该服务。若调用方以 getter 提供选项，移除赋值还会移除一次属性读取；这是待确认的兼容边界，不能泛化为任意注入对象均无副作用。
- 影响与建议：删除私有存储与删除构造选项不是同一项变更。后者会影响内部源码消费者的配置类型；将服务真正接入 AppManager 又会改变路由与生命周期。需要负责人先决定这一注入入口是废弃还是实现，另开设计，本轮保留。

**2. SnapshotBuilder.transformer**

- 导出路径：[SnapshotBuilder](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/snapshot/builder.ts:17) 经 snapshot/index.ts 和 engine/view/index.ts 内部导出，没有从 Runtime 包根或 exports 子路径导出。private 字段不公开，但 `constructor(transformer?: Transformer)` 是该导出类的可调用接口。
- 当前调用方：运行源码未找到实例化 Builder 的路径；[builder.test.ts](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/snapshot/builder.test.ts:45) 分别覆盖传入 Transformer 和默认构造。Builder.build 仍生成桌面、应用和日志文本，但其 DOM 遍历已停用，viewsMarkup 为空，buildViewTree 接收 null，字段不参与输出。
- 副作用：默认构造会执行 `new Transformer()`。[当前 Transformer 类](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/transformer/index.ts:32) 没有显式构造函数或实例字段初始化，方法只委托纯函数；从当前实现可确认默认实例没有额外的构造动作。调用方在传参前创建对象的副作用，则不会因删除 Builder 的存储而消失。
- 影响与建议：下一轮可删除未读取字段和默认实例分配；可选构造参数应先保持兼容，不能直接让现有 `new SnapshotBuilder(transformer)` 失去类型检查能力。实际快照主路径为 `Kernel.acquireSnapshot → Desktop.getSnapshotFragments → SnapshotFormatter.format`，它不是 Builder 旧 DOM 行为的逐项等价替代；若要删除整个 Builder，还需单独确认其旧文本与日志消费者。

**3. SnapshotFormatter.appLogLimit**

- 导出路径：[SnapshotFormatterConfig 与实现](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/snapshot/formatter.ts:34) 经 snapshot/index.ts 内部导出，没有 Runtime 包入口导出。SPI 的 `ISnapshotFormatter`、`IDesktopMetadata` 是公开接口，后者仍声明 `getAppOperationLogs(appId, limit?)`。
- 当前调用方：Kernel.acquireSnapshot 动态创建默认 Formatter；[formatter.test.ts](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/snapshot/formatter.test.ts:12) 和 formatter.toolname.test.ts 直接实例化它。未找到传入 appLogLimit 的源码或测试调用。该字段只在构造器读取配置并保存；当前 buildApplicationSection 不读取应用操作日志，systemLogLimit 则会传给 getSystemLogs。
- 副作用：读取配置、保存数字，本身没有日志读取或裁剪效果。实现 appLogLimit 需要决定如何读取、裁剪和插入应用日志，会改变模型看到的快照内容；删除配置会撤回注释中的行为承诺。
- 影响与建议：属于未兑现的配置，需要另开功能或兼容性设计，决定补实现还是弃用。不能把未读取字段当作可以顺手删除公开配置形状的依据，也不能以新增日志输出作为本轮清理。

**4. Kernel.transformer**

- 导出路径：[Kernel](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/kernel/index.ts:50) 经 runtime/src/index.ts 从 `@aotui/runtime` 包根公开导出；第三个构造参数类型 `ITransformer` 经 SPI 公开。private 参数属性不公开，但构造函数的位置和类型公开。
- 当前调用方：[createKernel 工厂](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/factory/createKernel.ts:47) 以五个参数调用 Kernel，并创建 Transformer 和 Dispatcher；createRuntime 调用这个内部工厂。kernel.test.ts、lifecycle.test.ts、security.test.ts 也在第三个位置注入 mockTransformer。当前 acquireSnapshot 使用 SnapshotFormatter，未读取这个字段。Host 的常用入口是 createRuntime，未找到它直接构造 Kernel 的调用。
- 副作用：Kernel 构造器只存储注入对象，不调用 transform。工厂执行 `new Transformer()`；当前类没有额外构造动作，但任意外部 ITransformer 实例可能在进入 Kernel 前已经产生初始化副作用。
- 影响与建议：保留。删除第三个参数会使现有 TypeScript 调用失败，也会让未迁移 JavaScript 调用中的 dispatcher、systemOps 位置错配。后续若要取消注入，应先设计兼容构造方式和迁移周期；仅消除未使用诊断不构成修改这个公共接口的理由。

**5. ViewManager 的兼容方法**

- 导出路径：[ViewManager](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/view/manager.ts:23) 经 engine/view/index.ts 内部导出，没有 Runtime 包入口导出。DesktopOptions 仍接受 `viewManager?: ViewManager` 注入。
- 当前调用方：[Desktop](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/runtime/src/engine/core/desktop.ts:195) 的 dismountView 在没有 Worker sandbox 时调用 dismount；mountViewByLink 的同类回退调用 mountByLink；hideView、showView 直接委托 hide、show。未找到 mount 的实际调用。构造器默认创建 ViewManager。系统 dismount 操作仍调用 Desktop.dismountView；system-operations.test.ts 验证此委托，但使用 mock Desktop，并没有证明 ViewManager 的空操作能改变视图。未找到直接覆盖该类的测试。
- 副作用：mount、mountByLink 会发出兼容路径警告；dismount、hide、show 是返回 Promise 的空操作。Desktop 在这些调用后继续发送 dom_mutation 信号。删除方法会令仍存在的委托失败；删除整条回退或改成真正的状态操作又会改变日志、信号或生命周期行为。
- 影响与建议：保留。需另行明确 Worker 模式下 hide/show 的语义以及无 Worker 时是否继续兼容，再评估方法删除。空实现不等于无调用，不应在参数清理中删除构造注入点或改变 Promise 契约。

**6. ArrayRefHandle 的泛型参数**

- 导出路径：[ArrayRefHandle<T>](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/hooks/useArrayRef.ts:55) 经 hooks/index.ts 和 sdk/src/index.ts 从 `@aotui/sdk` 包根公开导出；useArrayRef 的返回类型也显式使用 `ArrayRefHandle<T>`。
- 当前调用方：未找到业务源码或测试显式导入 ArrayRefHandle，也未找到 `useArrayRef<具体类型>(...)` 这样的显式类型实参。terminal-app、planning-app、lite-browser-app 调用 useArrayRef，并通过数据参数推断 T。sdk/src/hooks/useRef.test.ts 主要模拟格式字符串和 Map，没有实际挂载 useArrayRef；C04 的临时验证补充检查了真实 Hook 的注册、更新与卸载，但不作为永久新增测试计入原有数量。
- 副作用：泛型仅参与编译，没有运行时副作用；当前 T 不参与两个 formatter 的签名，确实是未使用类型参数。useArrayRef 自身仍会在 layout effect 中注册和注销对象，不能由此推出整个 Hook 可删。
- 影响与建议：保留类型实参数量。外部代码可能已经写出 `ArrayRefHandle<Article>`，改成非泛型会使其编译失败。若未来让 T 真正参与句柄能力，应作为 API 设计处理；仓库内未找到显式使用不能证明外部兼容风险为零。

**7. useLLMOutputChannel 的 options**

- 导出路径：[useLLMOutputChannel 与 LLMOutputChannelOptions](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/hooks/useLLMOutputChannel.ts:40) 经 hooks/index.ts 和 sdk/src/index.ts 从 `@aotui/sdk` 包根公开导出。
- 当前调用方：[TokenMonitorApp](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/demo-apps/token-monitor-app/src/tui/TokenMonitorApp.tsx:71) 以单个回调参数订阅 usage，没有传 options。未找到显式 includeHistory 调用，也未找到针对这个选项的直接测试。当前 Hook 订阅 Context 通道和两个 DOM 事件名，卸载时取消订阅；options 未读取，也没有在订阅时调用 getHistory。独立的 useLLMOutputHistory 会读取 Context 历史。
- 副作用：Hook 有真实的订阅、事件监听与清理行为。includeHistory 注释承诺默认 true，实际既不重放历史，也不根据 false 改变订阅。补实现可能让现有监听器多收到历史事件；Token Monitor 等累加型消费者是否允许重放，需要明确。
- 影响与建议：需要另开功能或兼容性设计。删除第二个参数或类型字段会破坏外部编译调用；直接补历史重放又改变运行时行为。先定义默认行为、去重及与 useLLMOutputHistory 的关系，再决定实现或弃用。本轮保留现状。

**8. useSignalStore 中接收 Signal 值的局部变量**

- 导出路径：[useSignalStore](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/sdk/src/hooks/useSignalStore.ts:15) 及 SignalStore 类型经 hooks/index.ts、sdk/src/index.ts 从 `@aotui/sdk` 包根公开导出；局部 `_` 不导出。
- 当前调用方：在上述源码范围未找到业务调用或直接 Hook 测试；入口仍公开导出它。局部绑定仅存在于 effect 回调的 `const _ = s.value`。
- 副作用：变量值本身没有后续用途，但 getter 读取发生在 Signal effect 内，是依赖追踪的一部分。Signal 更新后会再次运行 effect，进而 forceUpdate；effect 返回的清理函数交给 useEffect。删除整个读取会破坏这条订阅链，不能用编译器的未使用报告证明安全。
- 影响与建议：下一轮可仅删除绑定、保留 `s.value` 读取，并验证 store.set 后真实组件重新渲染及卸载清理。该改动不需要改变公共签名。本轮遵守只盘点的范围，完整保留绑定与读取；不能添加虚假读取来压掉诊断，更不能删掉真实订阅读取。

**待负责人判断的边界**

优先确认未兑现的 appHostService、appLogLimit 和 includeHistory 是实现还是弃用；确认 Kernel 构造注入与 ViewManager 回退的兼容周期；确认 SnapshotBuilder 的旧消费者迁移条件。ArrayRefHandle 的外部类型使用情况需要发布与消费方信息，不能仅靠本仓库搜索决定。SignalStore 局部绑定可作为下一轮最小内部清理，但必须保留订阅读取。

业务失败的外层包装、跨视图 Ref 解析、列表位置引用和 usage 字段映射仍属于已登记的独立功能修复，不纳入本报告对应的实现范围。
