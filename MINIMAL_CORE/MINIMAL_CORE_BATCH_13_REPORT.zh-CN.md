# Batch 13 · Planning 空对象引用的隔离修复候选

**READY_FOR_REVIEW。** 已复现首页和详情页的占位值进入模型上下文及业务的问题；两文件私有候选通过同一组正确合同。共享源码、永久测试、SRT、历史批次及 owner-review 均未修改。候选是否应用共享树，由负责人另行决定；没有提交或发布。

## 修复及所有权

候选只修改 `PlanListView.tsx` 和 `PlanDetailView.tsx` 的副本：

- 删除 `activePlan ?? {title:'No Active Plan'}` 作为 Ref payload 的做法。`ActivePlanSummary` 只在真实计划存在时挂载，使用原 `active_plan` 名。
- 删除 `current ?? {title:'No current phase'}` 作为 Ref payload 的做法。`CurrentPhaseTitle` 放在原有 current 分支内，使用原 `current_phase` 名。

两个普通 Preact 子组件没有创建新 View，也不改变工具、业务操作、Hook 签名或 Ref 名称作用域。它们在同一个真实 View 中调用现有 `useDataRef`；卸载沿用 SDK 的 binding cleanup，当前投影不再注册该名字。Snapshot 历史、lease、观察授权、调用资格与资源结算仍由现有 Runtime 管理。本批没有为旧观察增加失效规则，也不承诺旧 payload 即时被 GC。

App 作者多写了两个小组件，没有增加新的框架概念、策略、状态、计时器或引用查表。列表 Hook 继续无条件发布真实列表，包括空数组。

## 实际前后对照

运行链为 **真实页面 → SDK → Node Worker → Runtime → 默认 SemanticAOTUIDrivenSource → 真实 Driver / LLMClient / streamText / OpenAI-compatible provider**。仅在测试进程控制 provider 的 HTTP transport，返回受控 SSE；没有调用外部模型，也没有 mock Driver、Source、Scope、SDK 或业务执行。公开 Scope 的观察/调用边界只作委托记录，默认 grant/authorize/read 策略没有替换。

| 新取得上下文的状态 | 修复前的实际模型请求与调用 | 候选的实际模型请求与调用 |
| --- | --- | --- |
| 没有当前计划，详情计划没有阶段 | 正文显示两个“没有”提示，末尾仍列 `active_plan`、`current_phase`；两个强制调用均成功，业务收到两个只有 title 的占位对象，各进入 1 次 | 提示保留；Runtime Observation 和模型请求均无这两个名字。强制调用均 `not-dispatched / rejected / REF_NOT_VISIBLE`，业务各 0 次 |
| 计划出现，存在 pending 阶段 | 原名可见；收到完整 Plan 和 Phase，各进入 1 次 | 原名、正文、完整递归冻结的值、模型侧工具定义及完整工具结果保持，各进入 1 次 |
| 退出当前计划，阶段变为 completed 后的新上下文 | 两个占位名字再次出现，强制调用再次各进入 1 次 | 同名不再出现，强制调用仍在派发前拒绝，业务各 0 次；观察的 snapshotId 已随提交改变 |

每次 Driver 受控请求返回两个串行 tool call，共 **3 个真实模型请求 / 6 个 tool call**。仅这些调用的业务进入数从 **6 → 2**，删除的是 4 次占位值进入；没有自动重试。另有两个列表元素合法调用保持各 1 次，所以完整探针的 Ref handler 总数是 **8 → 4**。

列表对照也经过默认 Source 和真实 Scope：`Plan[]:unfinished_plans` 在三种状态均发布并获 grant，整体消费仍为既有 `REF_VALUE_UNSUPPORTED`、业务 0 次；前两种状态的 `Plan:unfinished_plans[0]` 正常返回对应完整 Plan。退出后页面显示 “No unfinished plans.”，数组名字仍在可用引用中，但元素名字消失。这证明移除的是不存在的对象，不是合法空列表；没有将“发布数组”混写成“工具已支持数组参数”。

页面正文在 `Available references` 之前逐字节相同；模型收到的完整工具定义、合法对象的工具结果、列表对照的完整输出均相同。详情页在有阶段时，引用枚举顺序因子组件挂载顺序改变；名字及归属的集合保持。该真实差异与独立实例 ID、诊断调用序号均在原件中保留，没有归一化错误 code/message/details 或业务数据。

## 基线、准出和可追溯性

- 任务书 SHA-256：`334001c193d87fcde99f88e53d3864951b01b24e3d7ab1c7b5afc98b24f318bc`。开工 HEAD 为 `8938449925ada2f92e072e1c0492af8f2428d14f`，基线来自实际未提交工作树。
- 保存了 302 份实际 Driver/Runtime/SDK 源码及构建输入、两页和真实业务类型 preimage、依赖解析及源码归档。在私有目录先重建 Driver，再重建 Runtime/SDK；SDK 与 Runtime 使用本次私有 Driver，不加载旧共享 dist。
- Node v24.15.0、TypeScript 5.9.3、Preact 10.29.1、TypeBox 1.4.3、AI SDK 6.0.86、OpenAI-compatible 2.0.30。项目包为 SDK 0.3.0 / Runtime 3.0.0 / Driver 0.3.0。未安装或升级依赖，复用缓存路径；不是干净安装验证。
- 未修改页面前，严格编译先退出 0，再经过完整真实链得到有效红灯：10 项空状态合同断言失败，6 次 Driver 调用与全部阶段完成，失败前已保存完整原件。候选严格编译和同一合同退出 0。两者都使用 strict=true、skipLibCheck=false，没有 skip 或弱化断言。
- 保存原件后，在第二个全新私有目录从归档独立重建并执行 **12 个步骤**：基线有效红、补丁检查/应用、候选绿、完整输出比较、补丁反向检查/恢复。全部满足预期；基线退出 1 是合同红灯，不计作测试通过。补充核对实际 Runtime grant 与模型引用一致，证明不是只过滤正文。
- 两页及夹具的完整导出声明逐字节相同。两文件补丁正向重放等于候选、反向恢复等于开工 preimage，whitespace 检查通过。
- Driver 工作结束并 stop/dispose，Context 沿原合同释放；Source.dispose 之后执行 Runtime managed close。两轮及独立复跑的 close 均成功，retainedScopes、retainedBytes、Worker pool total、pendingTasks 均为 0。此数值是完整关闭后的结果，不宣称已证明 GC/RSS 或在全局关闭前的全部资源统计。
- 8,910 个既有文件、开工已有的 3 件 owner-review 原件、302 个共享构建输入、真实两页与类型文件均保持。SRT 未构建/修改，交付核对的 294 个输入仍匹配已签收 Batch 12；其 HEAD 由独立工作线推进，不归入本批贡献。Git HEAD/index 保持。

独立候选 [MINIMAL_CORE_BATCH_13.patch](MINIMAL_CORE_BATCH_13.patch) SHA-256：

`860e59ba2b3e362eb90ad4f4908119019216c9721b1356893e6860ddc88053dd`

完整命令、先红后绿、实际 provider 请求、调用收据、声明原件、保护核对和一条复跑命令见 [证据索引](review-evidence/minimal-core-batch-13/README.zh-CN.md)。

## 失败记录与验证边界

首次探针错误地对冻结 ScopeClient 用 Proxy 返回替代方法，触发 Proxy invariant；已仅将记录器改为委托的普通对象，原日志保留，**不作为有效红灯**。另一次比较误把两个独立 Runtime 的私有执行身份当稳定输出；已改为比较完整的实际模型工具定义，另存原始身份与失败说明。这两项都没有靠改生产代码解决。

本次挂载的是真实两个页面与验证用只读 Ref 消费者、fixture 状态控制；没有运行完整 Planning App 的存储/CRUD、真实用户会话或线上模型。没有测试旧 Observation 跨新状态的调用规则、多/可选 Ref、SRT 接线、完整 Semantic 验收，也不改变数组消费限制或实施统一 Ref API。负责人提供的 [默认 Source 原对照](review-evidence/minimal-core-batch-13/owner-review/default-source-trace.json) 是独立证据，使用不同业务 fixture，没有被当成本次新增结果或宣称逐字节相同。
