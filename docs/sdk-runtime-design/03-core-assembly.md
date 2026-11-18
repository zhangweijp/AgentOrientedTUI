# 03｜纯 Core 已经存在，为什么公共装配仍然过细

文档 ID AOTUI-D03 · 修订 0.5 · 2026-11-18（Asia/Shanghai）

> 接管基线为 `90449dc2d` 加本批工作树。内部组帧顺序已收拢并验证。独立 Host 的公开装配入口仍待讨论。

## 本批判断

默认 SDK 作者已经可以只写页面与行为。真正容易接错的是第三方把 SDK App 接入另一执行环境时，需要自行把“候选绑定”和“已生效绑定”接起来。本批把仓内两个生产者的接纳顺序归到已有投影协调器，保留独立消费路径作为公开合同的对照。

## 一、先用 IDE 的连续操作，看见“装配”究竟在解决什么

用户的问题是：

> “可以深入浅出的详细说说 ‘纯 Core 已经存在，但公共装配粒度过细’”

设想 Agent 用默认 Preact SDK 开发一个 IDE。起初只有 `Files` 页面，`view_id=files`、`type=FileList`，展示文件结果数组与对应 refs；尚未打开 `Editor`，因此没有对应的编辑工具。打开 `test.txt` 后，出现 `view_id=editor`、`type=FileDetail` 的页面及该类型的编辑工具。再打开另一个 `FileDetail` 页面，仍只需要一组类型工具定义。

编辑操作返回回执，文件内容通过 View 更新；当前页面区域只保留 `editor` 的最新快照。以后这个页面可以从 `test.txt` 切到 `notes.txt`，不需要为了更换业务对象而强制 remount。Messages 同时承载当前事实与记忆，这种页面更新不意味着删除其他有价值的历史。

再看一个更容易出错的步骤：Editor 已打开，某个操作要接收 Files 页面选出的文件对象。Files 内显示的是 `[测试文件](File:results[0])`；调用时 Ref 地址是 `files.results[0]`，而 `view_id=editor` 指定接收调用的页面。**这两个地址各司其职，不能因为文件来自 Files，就把接收页面也改成 Files；显示地址也不能直接充当调用地址。**

如果模型开始输出后，Editor 已切到 `notes.txt`，模型也不会在这次生成中自动看见变化：输入已冻结。一个仍具调用资格的操作，其 Ref 来自 `originalObservation`，执行的是当前有效绑定的 handler 闭包。该操作是否仍适合当前文件、是否存在版本冲突，由 App 判断。Runtime 不能靠重建页面或换一份 Ref 数据，偷偷替应用消除冲突。

Agent 开发者的任务应是描述这些页面与业务行为。当前默认 SDK 已经封装了不少工作，**并非每个 App 作者都在手工组装 Core**。问题出现在集成者希望绕开默认托管、独立复用 Core 时：他除了写 IDE，还要亲自保证身份、frame 接纳、执行绑定、观察持有和关闭顺序彼此一致。要作为 Infra 广泛复用，就要决定哪些知识留给 Runtime 作者。

## 二、同一份 App，默认 Host 和独立集成者各做多少事

接管首批选 03，因为能用同一个动作分清三种责任。Agent 在列表上看见第一个条目，在另一详情页调用共享的 `inspect`，随后关掉列表再按原 ID 重开。App 决定条目内容，执行端辨认重开的页面，调用端辨认最初看见的条目。若其中两项由不同接入方各写一遍，同一份正确的 App 就可能随 Host 改变行为。[列表／详情 App](../../sdk/tests/fixtures/work-items-preact.tsx) · [业务声明](../../sdk/tests/fixtures/work-items.ts)

两条路径都加载同一份归档中的 JavaScript 和清单。默认路径用 `AppRegistry.registerTransient`、`installAll` 装入真实 Worker，从 Desktop 取得运行实例，再向 Runtime 取得 interaction。独立路径在测试进程内直接初始化同一 factory，通过已安装的 `/core` 与 `/spi` 装配。两个实例进入同一套 Source、Driver 和 provider 序列化器。Desktop 清单在此处拼合，模型响应由替身给出，App、跨线程提交、接收、调用与收据都实际执行。[包消费场景](../../sdk/tests/fixtures/assembly-consumer.mjs) · [归档来源与依赖](05-compatibility-and-distribution.md)

| 一个动作 | 默认托管已经承担什么 | 独立消费今天要写什么 |
| --- | --- | --- |
| 打开实例 | Host 选定安装配置，托管层建立实例和生命周期，SDK 作者写一份工厂 | 让 Snapshot Core、View 工具注册表、投影协调器和 interaction 使用同一对 App / instance 身份。把唯一本地实例接入 SDK lifecycle，并供应提交屏障 |
| 提交页面 | AppKernel 接 SDK 帧，绑定和正文在整帧验证通过时一起生效 | 向注册表取得候选挂载和激活身份，把同一挂载分别填入 View 和 Ref，把 `plan.accept` 延迟交给 coordinator，再把成功或失败的发布送交接收端 |
| 采用并执行 | Host 选授权策略，interaction 负责资格与防重，Worker 在执行端复查实例和绑定 | 供给 grant、授权和收据读取策略。执行 resolver 必须选回同一实例，并返回稳定 binding，接上 `isLive`、当前 handler 与实际执行阶段。观察与调用还要等 SDK 的 `whenCommitted` |
| 关掉实例 | 走 Desktop 关闭与 Runtime shutdown，有可等待的退出报告 | 停接受新工作，关闭 interaction，等在途责任结束，调用 App 清理，分别释放 projection、registry、store。自定义执行环境仍要处理自己分配的物理资源 |

在这个用例中，默认 Host 从创建 AppRegistry 到取得可用 interaction 共 7 行，关闭另走 Desktop 和 Runtime。独立函数从接工厂到提供关闭与释放断言共 72 行。其中光是把作者帧接给 coordinator 就有 14 行。两侧计数的起止点不同，真正值得收回的是这 14 行中三条必须一起维护的规则，分别是匹配挂载、绑定 Ref 来源和推迟接纳。[逐行可查的接线](../../sdk/tests/fixtures/assembly-consumer.mjs)

独立路径只为一个串行 App 接普通帧，允许本例的业务操作，观察使用固定限额。它没有复刻默认 Worker 的开页容量准入，也没有持久化。若要支持任意 SDK 工厂，还需覆盖部分初始化失败、开页现行分支和未终结调用。已有纯 Core 样例也证明直接生产快照的集成方可以独立使用这些部件。[纯 Core 消费者](../../runtime/tests/fixtures/public-core.ts) · [当前 Host 合同](../../runtime/README.md)

## 三、从一次错误的提交顺序识别所有权

原默认 AppKernel 的顺序是正确的。仓内另一个真实注册表与接收器的集成用例却先调用 `frame.accept()`，再交给 receiver 校验，并手写发布序号和完整快照。只要新页面绑定本身合法而同帧的 Ref 有错，两者就有机会看见不同的编辑器。这个反例定位到了**生产端接线**。默认 Host 的同一故障没有复现。[已迁移的消费者](../../tests/agent-driver-adapter/real-core.integration.test.ts) · [执行端 AppKernel](../../runtime/src/worker-runtime/app-kernel/AppKernel.ts)

| 状态或判断 | 原 owner → 本批落点 | 原位置删除什么，谁少记一条规则 | 仍须检查什么，怎样验收 |
| --- | --- | --- | --- |
| 同帧的 View、Ref、Tool 与候选挂载的映射 | AppKernel 私有映射和集成用例各自接线 → 内部 `commitAppFrame` 共用已有 coordinator 与 registry | 删除 Kernel 的私有组帧方法。集成用例删除提前 `accept`、手填身份与工具表、手增 epoch / sequence 和快照头。两处都只提交作者帧 | registry 决定挂载和激活身份，coordinator 校验整帧和已配置的容量后才接纳，跨 Worker 接收方仍独立校验到达的数据。重复 Ref 后旧挂载和 handler 保留，新挂载不能生效 |
| 当前 handler、实例 context 与执行权 | registry 和 App 执行端继续拥有，AppKernel 保留活动门禁 | 提交 helper 不保存闭包、上下文或第二份绑定表。默认 SDK 作者继续只交页面和 context | 用相同 owner 和相同可见正文换到另一文件，接收端可判定内容相同，原有效 receiver 实际执行新 handler。关闭重开后同名 receiver 被拒绝 |
| 观察资格、原 Ref、收据与在途引用 | 调用端 interaction 与 Snapshot Store 继续拥有 | 默认 Host 复用现成 interaction。独立消费者仍须注入策略和执行 resolver，新增 helper 对这一侧没有节省 | 采用、授权后复查、按原观察查询、迟到终态仍经过原边界。分别检查过期接收页、等待超时后的迟到结果与终结后的持有数 |
| App 的启停与物理退出 | AppKernel 拥有实例与 App 清理，Worker Host 拥有线程和通道 | 不引入 Session 或新的关闭标志。普通 App 作者继续只登记自己的清理，第三方执行环境接管自己创建的资源 | 停接单、调用等待结束、物理退出分别取证。同进程检查持有/绑定，默认路径检查 shutdown 的释放结果 |

新内部函数只把一项原本要重复维护的顺序交还给已有所有者。先准备一个新挂载，再用两个同名 Ref 使候选失败，回归用例在 registry 边界仍读到 `test.txt`。同一原挂载恢复，换上新的回调，正文仍为 `Editor`，快照去重而 handler 已能读出 `notes.txt`。正常交互仍通过健康与授权门禁。这个用例可以区分“正确保留旧绑定”和“碰巧还显示旧正文”。[实现](../../runtime/src/core/projection/coordinator.ts) · [回归用例](../../runtime/src/core/projection/coordinator.test.ts)

## 四、此次贯通实际证明了什么

| 设定与动作 | 两条路径的可观察结果 | 这决定了哪条边界 |
| --- | --- | --- |
| 两个 Item 页面都打开，先重排列表再跨页选择 | 每个 App 的请求中只有一个 `inspect`。调用指定详情页 `b`，引用列表页的 `items[0]`。在同一轮先把列表反转，后执行的选择仍写入原值 0。下一轮每个逻辑页只有一份当前正文，摘要页显示一次检查 | 类型工具定义可共享。来源页、接收页、原值和当前处理函数须分别绑定。成功收据只有 `success`，内容变化由 View 表达 |
| 关闭再重开同名列表，随后继续用旧观察调用它 | 两个实例均返回 `VIEW_INSTANCE_REVOKED`，执行阶段为 `not-dispatched`。只关一个类型实例时，另一个 Item 页仍有接收共享工具的资格 | 发现工具和选中具体挂载是两次判断。Host、SDK 作者都无需给重开的业务页发明新公开 ID |
| 按原标识查询并关闭 | 由 provider 返回的 11 个业务调用产生 9 次成功、2 次拒绝。两条路径上的 11 份收据都按原 `observationId + invocationId` 读回。关闭托管实例后其页面和工具从下一请求消失，独立实例仍可见。结束时独立实例持有、逻辑字节和绑定均归零，默认 Runtime 的关闭报告确认资源释放 | 资格、历史收据和资源寿命各有 owner。App 从清单或预览消失只能证明呈现变化 |
| 预算不足，或两实例中仅一个采用成功 | 六轮中四轮进入真实 provider 的 HTTP 传输边界。预算不足的候选零采用，两个旧观察均仍可调用。故意在第二个实例采用前释放其候选时，只有第一个采用，整轮零发送。下一轮重新观察并发送 | Host 必须基于同一候选检查请求，再逐一采用。接收端与执行端共用一个 Session 也无法使跨 App 采用变成原子操作 |

请求参数、别名与预算的取证归 [01](01-messages-facts-and-memory.md)。本轮另运行原有纯 Core 安装包样例，看到两次独立见证分别为冻结值 `old!` 和 `new!`；关闭后观察槽、逻辑字节、快照持有和工具绑定均为零。工作区现有 Worker Host 用例还覆盖了等待超时后换观察并接收迟到终态，以及强制关闭直到确认退出。两类证据分别标识，串行包消费样例没有为演示超时另外发明一个后端。[纯 Core 样例](../../runtime/tests/fixtures/public-core.ts) · [在途与关闭用例](../../runtime/src/engine/app/worker-host.scoped-interaction-e2e.test.ts)

本轮工作区共通过 62 个不同的定点用例，覆盖投影协调器、registry、interaction 关闭、AppKernel 释放、SDK 当前 context、真实 Core 的 adapter 集成，以及上述两种 Worker 在途结算。实际运行器为已安装的 Vitest 3.2.4，Runtime 清单声明 `^4.1.12`。包消费另从新构建的 tar 执行，其七个检查步骤单独计数。已有文件 App 用例也实际走过首个详情页打开后出现编辑工具、最后一个详情页关闭后撤回的流程。[SDK 当前 context 用例](../../sdk/src/view-type-tool.integration.test.tsx) · [关闭与持有](../../runtime/src/core/invocation/scoped-interaction.close.test.ts) · [文件 App 包消费](../../sdk/tests/fixtures/worker-app-contracts.mjs)

## 五、三种现在能比较的方案

| 方案 | 消费者得到什么 | 立即成本与长期代价 | 改选条件 |
| --- | --- | --- | --- |
| A．默认托管 + 高级 Core，内部统一提交（本批已做，推荐保持） | 普通 Host 用已管理的 interaction。SDK 作者沿用原有工厂。两处内部生产者少写有先后依赖的协议 | 维护一条内部联系和一条包消费回归。独立 Host 仍自行接四个部件和执行、关闭协议 | 有人要维护非 Worker SDK 宿主，且能指出重复承担的具体责任时评估 B |
| B．仅把“提交 SDK 作者帧”放入已支持的 Core 子入口（待审） | 独立 Host 可把组帧块替换成一次提交，移除它自己填挂载、Ref 所有者、延迟 accept 的规则。已直接生产完整快照的消费者可继续用现有入口 | 要稳定作者帧、挂载登记与失败返回之间的组合。调用方仍须安装策略、发布端口、执行 resolver 和关闭顺序。SDK 作者与默认 Host 无需迁移 | 只有请求者确实要控制其余装配，且公开这一窄步便能满足需求，才值得承诺 |
| C．支持第三方在另一执行环境直接托管 SDK factory（待审） | 集成者供应身份、环境配置、投影交付、实际执行资源和授权策略。Runtime 可复用 AppKernel 所有的实例初始化、提交及 App 清理，独立代码才有机会删掉运行上下文接线 | 要划清创建失败、消息未交付、在途终结与物理退出。公开一个包住四个部件的类仍会把这些责任留给调用者。长期需要支持一种额外集成合同 | 有具体 Host 愿意接管物理执行并消费整段生命周期，而且 B 仍要求其复制 AppKernel 的工作，再针对该 Host 验收 |

B 的最小改法可在包消费用例中直接核对：把 `publishFrame` 中从 `build()` 到 `accept` 的整段换成形如 `commitAppFrame(projection, registry, build, options)` 的操作，后面的 `publishTo` 和实际交付结果仍属于调用者。这是候选签名。C 的验收要求更高，同一个工厂必须还能在初始化半途失败时释放已分配资源，关闭期间仍能结算已分发的调用。把 `open`、`close` 和 `invoke` 转发给旧对象并不能通过这两项验收。

## 六、决定、收益与下一步

**本批采用 A。** 使用 App 的 Agent 可以使用原观察中的值继续操作。若接收页面已重开，Runtime 会明确拒绝旧调用。开发 App 的 Agent 用同一份公开 SDK 声明即可在两条受测路径得到一致行为。独立集成的成本也有了可以逐段删减的基线。任务成功率、生成正确 App 的首轮成功率和修复轮次仍需真实 Agent 测量。

需要产品评审的一项是**是否把第三方自行托管已构建的 SDK factory 列为近期正式支持对象**。建议当前把默认 Worker 和既有高级 Core 作为支持重点。若优先服务这类第三方，需要先确定其想拥有帧交付还是整个执行环境，再据此选 B 或 C。普通 Host 想接入另一家 LLM，已能复用现成 interaction，这种需求本身不足以支持 C。[默认 Host 入口](../../runtime/README.md) · [后端边界](04-execution-backend.md)

首批建立的原样 App 归档已用于后续实现。第二批直接测量并消除了准备阶段及重复发布时的冗余摘要。第五批又用同一归档在默认托管和独立 Core 上核对 11 张收据与释放。两类改进均通过既有装配入口交付。未来若出现需要自行托管 SDK factory 的 Host，以上基线可用于比较它接手了哪些资源和顺序。[包消费入口](../../sdk/tests/package-consumer/verify-package-consumer.mjs) · [摘要测量](12-snapshot-performance.md) · [原样产物验证](05-compatibility-and-distribution.md)

## 决策日志

| 日期 | 状态 | 记录 |
| --- | --- | --- |
| 2026-11-18 | 提案，待讨论 | 保留纯 Core 优势；以现有 AppKernel 为起点提取单一 AppExecutionSession；调用端统一拥有观察装配；不增加通用插件平台，不实施代码变更。 |
| 2026-11-18 | 文档修订 0.2；提案仍待讨论 | 先用 IDE 连续例子说明装配责任；澄清默认 SDK 作者与 Core 集成者不同；加入三个真实方案、即时/长期成本及实施证据门槛，不把内部收拢等同于立即公开 API。 |
| 2026-11-18 | 文档修订 0.3；提案仍待讨论 | 采纳 Review 的 owner 迁移核查，限定不能按 closed 变量名合并不同事实；区分内部整理、最小消费者验证与公开兼容承诺的门槛。 |
| 2026-11-18 | 修订 0.4，内部整理已实施，公开方案待定 | 用同一已构建 App 对照两路，收回两处组帧接线，验证失败候选、原 Ref、请求与关闭。以 A 取代先提取完整 Session 的默认推荐，B 与 C 分别以实际消费者责任为触发条件。 |
| 2026-11-18 | 修订 0.5，五批结项后保留 A | 摘要优化与 Driver 响应修复均复用原有装配和冻结的 App 产物。B、C 仍以非 Worker 宿主实际接手的生命周期为评审依据。 |
