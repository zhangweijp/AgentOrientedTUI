# 06 · Preact 到语义帧的提交桥

文档 ID：AOTUI-D06 · 修订：0.4 · 更新：2026-11-18（Asia/Shanghai）

**当前 Preact 提交桥已经集中管理其版本相关字段和提交队列。** 第四批在该处改善了无提交诊断，保留真实异常的本地原因。负责人已独立复验这部分行为。更换提交模型、SSR 和自定义 renderer 仍按需求与迁移成本另行讨论。

## 状态与范围

| 项目 | 当前记录 |
| --- | --- |
| 状态 | 常规准备的无提交诊断和本地异常原因已落实。更换提交模型仍待讨论 |
| 复验基线 | `90449dc2d` 加前三批及第四批首版工作树，Preact 10.29.1、SDK 0.9.0、Runtime 8.0.0 |
| 最近讨论 | 2026-11-18，Asia/Shanghai |
| 本文负责 | 何时形成可提交的完整投影、如何隔离渲染器时序依赖 |
| 相邻议题 | [07](07-dom-adapter-boundary.md)负责正文转换；[08](08-ref-authoring-scope.md)负责作者作用域；公开 AppContract 由议题 05 统一确定 |

**当前默认作者入口仍然是 Preact。** “改用纯 TypeScript 默认入口”仅是此前候选意见，未成为决定。开页准入已按用户要求暂缓，本文不展开其重设计。

## 用户原话与已确定边界

> 6. “最值得重构的部分，是 Preact 到语义帧的桥” 有优秀/成熟的解耦方案吗？

> AOTUI 的一个 View 实例 对应的 就是 GUI 网站内/桌面应用的一个页面

View 可以展示多个业务对象，也可以在同一页面内切换内容。页面身份不能被重新定义为固定业务对象身份。Messages 同时承载外部事实和 Agent 的记忆；因此提交桥必须可靠，但它不因此获得任意修改其他消息的权限。

## 先看一个连续的 IDE 例子

以下是三篇文档共用的设计用例，工具业务参数仅作示意，不要求演示 App 使用这些字面名称。

1. Files 页是 `view_id=files`、`type=FileList`，展示 `results` ArrayRef。其中 `[测试文件](File:results[0])` 对应调用地址 `files.results[0]`。
2. Agent 打开 Editor 页：`view_id=editor`、`type=FileDetail`，显示 `test.txt`。页面打开且满足实例启用条件后，FileDetail 操作才可用；定义仍按 App + ViewType 共享。
3. 同一 Editor 可以切到 `notes.txt`，无须为每个文件创建新 View。一个示意切换请求是 `{ view_id: 'editor', target: 'files.results[1]' }`：接收页是 Editor，选择的数据来自 Files。
4. 切换操作返回结果与提示，新文件正文进入最新 View，仍用 XML + Markdown 包装为 User Message。这保持类似 CQRS 的分工，不让 Tool Result 复制一份当前文件正文。

此时桥要保证什么？**下一份成功投影中的页面正文、该次捕获的 Ref、实例工具绑定必须相互对应。** 例如，正文已经是 `notes.txt`，却配上上一轮 `test.txt` 的页面 Ref，是桥必须排除的混合状态；这里说明的是设计风险，不是声称现有代码已经发生这种错误。只比较 DOM 是否改变还不够：搜索结果的 payload 可以重排，显示标签却完全不变。

还要分开两个时间点：模型开始生成后，本轮输入固定，后台更新不会自动进入这次输出；随后执行时，Ref 解析依据原 Observation，App 的闭包、服务及磁盘状态仍可能已变化。提交桥负责一致来源，文件冲突由 App 检查，不能靠冻结整个应用世界解决。

## 问题：有稳定语义目标，但默认路径需要理解渲染器内部时序

当前链路是：组件渲染，View 与 Ref 登记，实际提交结束，读取完整页面，再交给 Runtime 准备投影。

证据集中在 [render-commit.ts](../../sdk/src/app-factory/render-commit.ts) 的 `installCommitHooks`、`trackRenderCommits`、`finishProjection`：实现依赖 `__c/__h/__P/__v` 等内部字段，包装共享 `options` 和调度队列，并追踪失败组件。随后 [createTUIApp.ts](../../sdk/src/app-factory/createTUIApp.ts) 调用 `readDOMAppViews`。普通 TypeScript 的 [createApp.ts](../../sdk/src/app-factory/createApp.ts) 已能直接构建同一类投影。

这些机制有现实原因：正文、Ref 与工具绑定可能在不同阶段登记，不能看到 DOM 更新就宣布整体已提交。现有[安装包提交验证](../../sdk/tests/package-consumer/verify-preact-commit.mjs)覆盖共享队列及 render、layout、class lifecycle 异常，说明项目在认真维护这条边界。问题是维护责任过多地集中在适配桥，而不是已经证明它经常出错。

这里已有明确的多根覆盖：安装包用同一份 Preact、同一个真实队列运行两个 App，让一根在 render、layout、class lifecycle 阶段失败，检查另一根的正文、Ref 和工具继续正确提交。不能把它写成尚未验证的空白。它最终同时关闭两根，尚不能单独证明“关闭 A 时 B 仍有待提交工作”的装配场景。

若 [04](04-execution-backend.md) 以后引入同进程后端，应继承上述验证，再明确环境所有权。[dom-app.ts](../../runtime/src/adapters/dom-app.ts)会复用或初始化全局 document/window；当前关闭只移除本 App 的 root，并不恢复共享 globals。逐 App 恢复全局 hook 或 document 可能反而影响另一根。[useLLMUsage](../../sdk/src/hooks/useLLMUsage.ts)还通过 document 接收冒泡事件，事件作用域也需随后端检查。这是第二后端的必要边界，不是已经证实当前受支持 Worker 后端存在隔离故障，也不要求现在实现新的环境管理器。

## 成熟方案能提供什么

[Preact Option Hooks 官方文档](https://preactjs.com/guide/v10/options/)明确把这些扩展点提供给库作者，并要求保留已有 hook 链；它们随包语义化版本发布，但没有同等的长期弃用政策。因此，**将 Option Hooks 一概称为“不受支持的私有 API”不准确**。公开文档中的 `diffed` 是单个 VNode 完成后的通知；公开列表没有直接承诺“整棵应用树的正文、Refs、layout effects 均已完成”的 after-commit 接口。当前依赖的内部提交字段仍需单独承担维护责任。

| 方案 | 收益与局限 | Agent 作者成本 | 即时与长期维护 | 适用条件 |
| --- | --- | --- | --- | --- |
| A. 固定受支持 Preact，隔离现有提交桥 | 保留真实提交行为；内部字段依赖仍存在 | 现有 App 几乎不变 | 近期变化最小；长期仍需维护受支持版本和 hook 链 | 当前主路径已工作，尚无替代方案的实证优势 |
| B. 统一语义 frame 边界，Preact/纯 TS 各自适配 | 各作者入口复用同一验证；接口本身不能证明 commit | 可保持现有作者 API；不要求作者读 Worker 协议 | 近期要厘清边界；长期减少时序知识向外扩散，但不能新建重复 owner | 多入口已有重复逻辑，或桥的实现确需更换 |
| C. SSR/纯模板求值 | 便于从确定输入生成正文；不能直接继承现有持续挂载与 Ref 提交合同 | 简单页面易写；依赖 hooks 的 App 需要改写状态模型 | 模板原型小；兼容完整组件语义会迅速增大成本 | 应用能明确采用纯模板，并有足够收益证明 |
| D. 自定义 renderer，如 React reconciler | 可直接写入非 DOM 目标；仍需处理 host config、错误和生命周期 | 换框架或适配现有组件，迁移成本最高 | 初期工程量大；长期要跟随 reconciler 演进 | 已确定需要独立渲染平台，现有桥无法满足必要能力 |

[Preact SSR 文档](https://preactjs.com/guide/v10/server-side-rendering/)定义的是字符串、异步字符串及流渲染。能够运行组件函数，并不证明能替代本项目依赖的实时提交机制，这是基于两者合同差异的判断。[React reconciler 官方 README](https://github.com/react/react/blob/main/packages/react-reconciler/README.md)则明确其为实验性自定义渲染器包，介绍 mutation/persistence 两种模式，并提示 API 稳定性限制。成熟架构模式值得借鉴，但不存在已验证的 AOTUI 即插即用替代品。

## 推荐：先隔离责任，再改变桥的内部实现

按 Minimalist，先问现有机制能否满足要求，再复用已有 frame、捕获与验证。衡量简洁的标准是独立状态所有者更少、公共承诺更清楚、Agent 更容易写对，不是删掉校验来减少行数。A 与 B 可以逐步衔接；C 与 D 是有条件的替代实验，不应四条路线同时建设。

现有 Preact 提交桥已把 hook 链衔接、排队、异常、卸载，以及当前版本的内部字段集中在同一个模块。本批在这里改进诊断，继续由这条路径判定本次提交是否完成。Core 消费已准备的语义帧。普通 TS 入口直接构建同一类帧。进一步抽取的收益要由跨版本或跨入口的实际重复责任证明。

中长期让所有作者适配输出完整语义候选：页面正文、Refs、当前实例的操作绑定属于同一次提交。共享的是合同与验证，不是两个渲染器共享可变注册表。公开 DTO 和包边界应引用议题 05 的 AppContract 结论，不能直接把本地闭包、VNode、owner 对象冻结成外部 ABI。

下面是**拟议内部接口示意，不是现有 API，也不代表已批准命名**：

```ts
interface CommittedProjectionBridge {
  // 由适配器证明相关真实提交已完成；不靠固定等待时间。
  flush(signal: AbortSignal): Promise<{
    status: 'changed' | 'unchanged';
    frame: CompleteLocalFrame; // 本地类型，省略现有身份与校验字段
  }>;
  close(): Promise<void>;
}

const completed = await preactBridge.flush(signal);
return projection.prepare(completed.frame);
// 这里只完成本地准备，不代表模型已读或已采用新观察。
```

### 先区分两种失败，再讨论 `unchanged`

源码和 Preact 10.29.1 的已安装包都复现了以下顺序。

| 操作 | 准备结果 | 投影状态 |
| --- | --- | --- |
| 设为 1 | `prepared`，样例的 `sourceEpoch` 从 1 到 2 | 接纳此时的正文、Ref 和实例绑定 |
| 再设为 1 | `SNAPSHOT_INVALID`，告知没有观察到本 App 的 Preact 提交，提示检查回调是否改变该 App 使用的状态 | 仍有 epoch 2 的健康帧 |
| 设为 -1，组件抛错 | `SNAPSHOT_INVALID`，保留原失败的路径与消息，并在本地 `cause` 中带回原异常 | 对 epoch 2 记录真实投影故障 |
| 仍处于故障时执行无更新回调 | 返回已有故障 | 继续等待实际修复 |
| 显式修复为 2 | `prepared`，epoch 前进到 3 | 可再次形成完整的健康投影 |

SDK 在常规回调与排队工作结束后，发现没有该 owner 的 render work 且没有现存故障时，才使用无提交诊断。Runtime Coordinator 拥有已接纳的帧和 epoch。Core Store 保存实际发布快照及故障状态，发布失败后可保留供诊断的 `lastGood`。Observation Registry 按观察采用和释放管理执行来源资格，当前仍须通过实例、激活与执行检查。这些分别是准备、发布和观察的事实。工具的业务结果仍按 App 收据判断，准备失败本身无法说明业务变化是否已经发生。[提交桥](../../sdk/src/app-factory/render-commit.ts)、[SDK 回归](../../sdk/src/public-api-contract.test.tsx)、[Core 健康与采用回归](../../runtime/src/core/invocation/observation-registry.test.ts)

真实 render、layout 和 class lifecycle 的原原因通过已有失败结果保留在本地 `Error.cause`。发布端仍报告既有的有界 issue。在同一个 Preact 队列，两根 App 的故障和健康提交是独立的，安装包回归检查了另一根能继续发布正文、Ref 和工具。[安装包提交验证](../../sdk/tests/package-consumer/verify-preact-commit.mjs)

`unchanged` 仍是待讨论语义：例如 Agent 已在 Editor 选中 `test.txt`，再次选中它可能不产生 render。只有能够证明该 owner 的最后一份投影健康、相关已登记提交已排空且没有未处理错误时，才能考虑返回未变化；框架不能猜测 App 未声明的业务变动。

已安装包测试让 `[Selected value](selected)` 保持字节一致。修复后 Ref 的值从 1 更新为 2，同一激活的 handler 读取到 2，证明正文相同的实际提交仍会更新 Ref 和实例 context。检测依据是现有 Preact 提交桥记录的工作，Runtime 按完整帧接纳。

**后续触发条件**是：受支持版本升级反复要求修改桥外模块、两个作者入口开始复制同一状态机，或出现必须支持的非 DOM 作者需求。届时先用共同 IDE 场景证明 B 能减少实际耦合，再讨论 C/D；没有这些证据时，不为“以后可能换框架”先建平台。

## 迁移与验收

1. 在现有内部提交桥维护受支持的 Preact 版本、同一模块实例与 hook 链合同。App 作者按 `SNAPSHOT_INVALID` 处理准备拒绝，排查时读取消息、路径及可用的本地 cause。
2. 用实际安装包验证 hook 链衔接、单根与多根、子树更新、Ref-only 更新、失败恢复和关闭。
3. 再以一个小 App 比较显式 frame 边界，确认工具、正文与 Ref 同源；通过后才讨论内部替换。
4. 若实验纯 JSX 模板，明确它的受支持特性；TypeScript 的 [JSX runtime 配置](https://www.typescriptlang.org/tsconfig/jsxImportSource.html)只提供编译入口，不能自动赋予 Preact hooks 或提交语义。

本批验证了相同值无提交、真实 render/layout/class 故障、多根隔离、正文相同的 Ref 与 handler 更新、修复和关闭。已安装的原样 Work Items 仍覆盖开关页面和旧绑定拒绝。后续换桥时仍应以同名重开、关闭时的在途等待、不同实例 context 及数据和 Schema 同源作为验收。安装包回归使用实际组件和模型替身，工程结果与模型自主完成任务的结果分别记录。

与议题 07 的分工是“何时可读”与“如何转换”分离；与议题 08 的分工是新作者语法仍进入同一次捕获和提交。桥的设计不能顺带决定开页准入或 rollback 策略；相关讨论继续暂停。

## 未决问题

1. 内部桥的最小返回值能否直接复用现有 frame 与准备结果，避免新造协议？
2. `unchanged` 应返回现有 epoch，还是单独结果类型？
3. 哪组受支持 Preact 行为需要成为升级门槛，哪些组件能力应明确不承诺？
4. 纯模板式语义 JSX 是否具有足够作者收益，值得独立适配实验？

## 讨论与撤回记录

| 日期与时区 | 记录 |
| --- | --- |
| 2026-11-18 · Asia/Shanghai | 用户要求研究成熟解耦方案；保留 Preact 默认作为当前事实，具体重构待讨论。 |
| 2026-11-18 · Asia/Shanghai | 撤回“Option Hooks 全部是未支持私有 API”的过度表述；改为区分公开扩展点与当前使用的内部提交布局。 |
| 2026-11-18 · Asia/Shanghai | “更换默认作者入口”保留为未采纳候选；开页准入暂停，不在本文推动实现。 |
| 2026-11-18 · Asia/Shanghai | 复核 [Review 06](REVIEW-2026-11-18.md#review-06)：采纳准备失败与健康状态分别解释的诊断建议；澄清双根失败隔离已有安装包覆盖，同进程环境装配仍有独立责任。详见 [审查回复](REVIEW-RESPONSE-2026-11-18.md)。均为设计建议，未改实现。 |
| 2026-11-18 · Asia/Shanghai | 在现有桥增加常规无提交诊断，沿用 `SNAPSHOT_INVALID` 和失败反馈，保留实际异常的本地 cause。改用新准备结果及换 renderer 各自待定。 |
| 2026-11-18 · Asia/Shanghai | 负责人分别在改前、改后安装包复跑同一 Preact 提交用例。无提交后 epoch 为 2，显式修复后为 3，实际 handler 读到 2。新包保留 render、layout、class 的本地原始异常，健康邻根正常关闭。列表正文另有未通过的例子，整批状态见索引。 |

## 文档修订记录

| 修订 | 日期与时区 | 变化与决定状态 |
| --- | --- | --- |
| 0.1 | 2026-11-18 · Asia/Shanghai | 建立事实证据、成熟方案边界与初始候选；没有批准实现。 |
| 0.2 | 2026-11-18 · Asia/Shanghai | 加入 Files → Editor 连续例子、原观察与当前执行时间区分，补齐作者成本、维护成本和升级触发条件；明确正文相同仍可能需要提交 Ref / enabled / binding；未改变默认 Preact，也未恢复开页议题。 |
| 0.3 | 2026-11-18 · Asia/Shanghai | 补充 no-render 与真实 fault 的健康差异、诊断优先级及已有多根验证边界；保留 `unchanged` 和第二后端设计的待讨论状态。 |
| 0.4 | 2026-11-18 · Asia/Shanghai | 记录已落实的常规准备诊断、原原因和包消费证据，说明提交、发布及观察的所有权。 |
