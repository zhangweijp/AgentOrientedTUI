# SRT-04／05 API 决策材料：独立复核与 r02 修订任务

2026-11-08，Asia/Shanghai。**整体裁决：CHANGES_REQUESTED。** 推荐 A 对前批 R1 的回应、单 Scope 资格原子性与组合部分失败对 R2 的回应，在设计论证层面认可。新增刷新链路的真实等待 owner、Preact 调度钩子兼容、SPI 消费者迁移，以及 Driver 协议检查顺序仍需补齐。公开 API、生产实施、共享采用、发布和最终 Semantic 验收均未批准。

## 1. 审查对象与验证边界

审查对象是 `review-evidence/srt-04-05-api-decision-20261108` 的六项封存材料：[manifest](../review-evidence/srt-04-05-api-decision-20261108/manifest.json) SHA-256 `e4f15fbdea51369a7aef111eb36918ab47b3c19754576556ca58c5aec9293895`；[DECISION.zh-CN.md](../review-evidence/srt-04-05-api-decision-20261108/DECISION.zh-CN.md) SHA-256 `b9acf498c71bbf7d04eb6342f076b9c9b2a61bce772dcc79850dbf3fafd382ff`。

本轮实际核对六项哈希／字节数、14 项新增源码身份、七项正常安装 Preact 10.29.1 源码身份，以及未来 67 项清单中的 66 个现有文件身份和一个新路径。检查清单身份不等于审查所有未来测试内容，更不等于授权修改 67 个文件。前批 26 项输入、22 对源码和已签署结论继续复用，未重新全仓盘点。

证据见 [本轮输入核对](../review-evidence/srt-04-05-api-decision-20261108/owner-review/input-audit.json)及[定向源码摘录与方案反例](../review-evidence/srt-04-05-api-decision-20261108/owner-review/findings-source-evidence.json)。本次另读 Preact test-utils 和作者验证的相关位置，以核对调度钩子先后顺序。

材料中的接口和迁移 diff 未应用、未编译。本轮未写生产，未运行新行为测试、TS、LSP、Host、GUI 或真实模型。以下反例来自代码顺序与提案推导，不能当作新实现的运行复现。

## 2. 前批问题的处理结果

| 问题 | 本轮判断 |
| --- | --- |
| R1：跨轮 current 延长 Scope／ledger 寿命 | 推荐 A 明确保留 Driver 每轮 finally 释放，轮间可没有 current；不再保证捕获失败能找回上轮已经释放的资格。长 Scope／重叠 owner 仍受原调用记录上限，收据 TTL 不删除防重条目。此论证可接受；未验证实际实现。 |
| R2：组合采用伪称整体回滚 | 单 Scope 的资格切换与多 App／来源的组合结果已分开。A 成功、B 普通投影失败可形成 A＋B issue；B busy／抛错导致整轮失败，承认 A 旧资格已不可恢复。该真实失败边界可接受；仍须在实现中证明来源、清理和终态。 |
| 过时 prepared 与实际调用 | Core／Source 分别定义准备开始顺序，旧准备晚到不能复活；同 App instance 的实际工作检查包括仍在 closing 的 Scope。这是需要保留的明确设计点，不是测试通过声明。 |
| raw 读取与 TTL | 原始 Store 读取不冒充会话调用资格；无 owner retired 数据退出被列为公开行为变化。TTL 沿用首次 sweep/access 才物理清理的边界已诚实写明，不虚构空闲时定时清理。 |

上述认可没有批准一整套采用 API，也没有把新增 renderer 方案一起签收。

## 3. 本轮必须修订的事项

### D1：刷新超时不能同时丢掉实际等待的占位

DECISION 第 4 节计划复用 `pendingRequests`／timeout，并承诺每 App 一个刷新。实际候选 `worker-host.ts:745` 的 timeout 会删除 pendingRequests 项；普通请求随后拒绝调用者。Worker 的异步消息处理不会因 Host 删除 Map 项而取消已经开始的 renderer 等待。拟议 wire 只有请求／结果，尚未说明取消如何到达该等待。

若仍按该原路径实现：一个 scheduler 长时间不调用 callback，Host 超时删除项，下一次 observe 又发送新请求，就可能累积 Worker 的 promise／waiter。称“每 App 一个”不能替代真实 owner 和终点。

**r02 要求：**分别列 caller、Host 活跃刷新身份、Worker waiter、renderer callback 的终点。选择一种有界策略并写完整：例如调用者超时后仍由现有 WorkerHost 保留唯一实际占位，直到匹配终态或实际退出；或者定义能真实终止等待并确认结算的取消路径。只停止等待不能宣称渲染已取消。补 Scope.close、stop/reset、错误／迟到响应及真实 Worker 关闭规则；迟到结果可以结算真实占位，但不能重新发布或采用失效结果。明确 observe flush 与业务终态 flush 同时出现时的归属，不另建队列或通用管理器。

必须增加“反复 timeout／重试且原 callback 未完成”的有界验证设计，不能只验证一次超时返回。

### D2：调度钩子方案必须与现有作者验证有一致的安装／恢复合同

实际 Preact `test-utils/src/index.js` 的 `setupRerender` 先保存并替换 `options.debounceRendering`；`act` 的回调结束后才 drain，并在 teardown 恢复进入时的钩子。现有 `sdk/tests/srt01-m4/author-eval/check.mjs:55` 在 `await act(async () => initializeComponent(...))` 内初始化 managed renderer。

因此，按原草图在该初始化内部安装 SDK wrapper，act 退出会把 wrapper 覆盖。随后简单检查“钩子仍是自己”会把既有正常作者验证当作 PROJECTION_SCHEDULER_CHANGED。若在 act 回调内 await 一个必须等 act finish 才 drain 的 flush，还会形成等待环。这是具体时序缺口。

**r02 要求：**写清生产的钩子组合／恢复合同，以及作者测试支持的初始化、更新、flush、卸载顺序。不得访问 Preact `__test__` 私有字段、静默夺回其他 owner 的钩子，或通过弱化作者验收来掩盖问题。生产刷新仍不能依赖 act。需要区分支持的外部调度组合与明确不支持的永久替换，并让失败可诊断。

此外，Preact 的 `process` 是跨批次复用的同一个函数；“同一 callback 只执行一次”的保护应属于每次调度记录，不能按函数身份永久去重。安装源码要求 scheduler 异步调用，材料需说明同步 scheduler 是明确拒绝的非法用法，还是另行支持的行为；不能只把它列为测试名称而不定义结果。多 root 的拥有关系和失败影响边界继续列明。

### D3：新增 SPI 的消费者清单不完整，不能机械补空方法

新增必需的 `ComponentRenderer.flushPending`／`IProjectionPort.whenReady` 会影响手写 renderer／projection。执行方已主动指出作者评测脚本、AppKernel component、registry 和 factory-contract 夹具未在原 67 项中完整分类。负责人实际核对到作者脚本的手写 projection，以及 AppKernel／registry 的手写 renderer；未声称已审过全部夹具。

**r02 要求：**按“真实 managed 正例”“非法输入／初始化专用负例”“透传真实 renderer”分类，逐个说明是否迁移、为何迁移、要保留哪个断言，并增补精确文件身份清单。需要真实提交完成的正例必须有真实完成边界；只检查非法输入的负例不能被补成合法对象。透传对象已经具有新方法时不重复造实现。不能全仓机械加入空 async flush，也不能把清单扩充当作自动实施授权。

### D4：协议配对检查必须先于输入未变的快捷返回

`consumer-migration.diff:34` 在 `contextMode`／lifecycle／adopt／release 检查前执行 `isUnchanged(initial)` 并返回。DECISION 也将初步输入签名检查放在采用前，但没有明确检查已经在 capture 内完成。现行 `captureContexts` 仅调用 getContext 并保存，没有这些新协议检查。

这样写出的示例允许“签名没变，但 marker 或方法缺失”的错误 Context 静默跳过，与“配对失败必须拒绝”的合同不一致。

**r02 要求：**把配对／方法的运行时验证明确放在捕获后、任何输入未变优化之前；真正 adopt 可以继续延后。新增“相同输入签名＋缺 marker／adopt／release”的拒绝场景。普通 Source 仍不承担 Observation，不能因此给它增加必需 adopt。

### M1：说明用预览构造参数顺序需纠正

迁移示例使用 `new SemanticAOTUIDrivenSource(kernel, desktop, options)`，实际候选构造函数参数是 `(desktop, kernel, options)`。即使是未编译的说明片段，也应与明确公共用法一致。r02 同步修正；这不是生产缺陷。

## 4. 下一批范围、准出条件与 Prompt

下一批仍然只修订方案材料。执行方在本批目录的 r02 修订区完成新的 DECISION、签名、说明 diff、验证矩阵、精确文件清单和输入说明，并单独封存 manifest；原六项不改。负责人只写本批 `owner-review` 与 `MINIMAL_CORE`，执行方继续维护唯一 `deepseek_review.md` 总账。无需重复前批盘点，不运行新合同或 TS／LSP，不改生产。

准出条件：D1 的每个真实持有有终点和有界重试行为；D2 的具体 act／scheduler 时序不自相矛盾，生产不依赖测试工具；D3 的受影响消费者完整分类且保留原验证含义；D4 的签名优化不能越过协议拒绝；M1 修正。各项文档、接口草图和示例一致，再由负责人给材料层 APPROVED／CHANGES_REQUESTED。

> 沿用六项封存材料和前批现状，完成本复核 D1–D4／M1 的 r02 文档修订。保留推荐 A 的每轮 finally 寿命和如实的组合部分失败边界。明确超时后 Host／Worker／renderer 的真实占位及关闭／晚响应终点；解决公开 Preact scheduler 钩子与现有 act 作者验证的安装、更新、flush、恢复时序，按每批调度记录保证一次执行；分类迁移手写 SPI 夹具；协议配对检查前置到 unchanged 优化之前，并修正预览参数顺序。只改本批方案材料、增补有针对性的身份／验证清单，不改生产、不重跑旧盘点或 TS／LSP／Host／模型，不引入通用管理器，不弱化作者评测。一次封存 r02，由负责人独立复核；任何材料批准都不等于公开 API 采用或实施授权。

## 5. 仍未覆盖的风险

真正的 renderer 行为、Worker 消息终点、adopt 重入与清理异常尚未通过新实现验证；双 Producer／正式包集成仍是后续实施门禁。既有 TS 7.0.2 候选和 SDK 工具的限定批准不扩大，Driver 上游严格类型与 LSP 正常关闭失败仍单独保留。Host 预览、共享采用、历史证据缺口及最终 Semantic 验收均未关闭。
