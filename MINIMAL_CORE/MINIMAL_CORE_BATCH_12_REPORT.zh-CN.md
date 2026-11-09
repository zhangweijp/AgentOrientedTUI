# Minimal Core Batch 12 · Ref 参数作者样例

**READY_FOR_REVIEW。** 现行对象 Ref 和数组元素可以消费；数组整体能发布，但被当前工具参数合同拒绝。统一作者写法已完成严格类型原型，尚不能在当前 SDK/Runtime 运行。本批没有修改共享生产代码、永久测试、导出、协议或 SRT 工作树，不实施 R4/SRT-02，也不提交或发布。

## 一张对照表

所有运行用例使用同一份 Planning 业务输入、原始 `PlanListView` 和一个 `inspect_plan` 工具。该工具沿用真实 `dual-producer-app.mjs` 的 `useViewSnapshotTool` 接线，参数为一个必填 Ref 加 `format`。工具返回简短收据；业务对象只由原发布方产生，handler 参数另外写入隔离诊断文件。

| 场景 | 作者声明与模型形式的 JSON 参数 | handler 值 / 进入次数 | 实际证据与边界 |
| --- | --- | --- | --- |
| 当前对象 | `useDataRef('active_plan', plan)`；`{plan:'active_plan', format:'summary'}` | 原快照的完整只读 Plan，1 次 | 真实 Worker、公开 Scope 调用成功；Ref、授权来源和收据指向同一原快照 |
| 当前数组元素 | Planning 原有 `useArrayRef('unfinished_plans', ..., {itemType:'Plan'})`；`{plan:'Plan:unfinished_plans[0]', format:'summary'}` | 同一个完整只读 Plan，1 次 | 发布和消费均成功；没有 App 查表或手工展开 |
| 当前数组整体 | 同一 `useArrayRef` 已注册数组；`{plan:'Plan[]:unfinished_plans', format:'summary'}` | 未进入，0 次 | 发布成功、观察已授权；调用为 `not-dispatched / rejected / REF_VALUE_UNSUPPORTED`，完整数组没有传给业务 |
| 候选对象 / 元素 | SRT 的一次 `defineViewTypeTool` + `defineToolSet`，参数写作 **`plan: RefValue(Plan)`**；handler 放在既有 bindings；目标模型输入保持上述 Ref 字符串 | **类型原型**可推导递归只读 Plan；没有执行次数证据 | `strict: true / skipLibCheck: false` 正例通过，错误方法、深层修改和错误 handler 被拒绝；`RefValue` 不是现有导出 |
| 候选数组整体 | 同一种写法：`plans: RefValue(Type.Array(Plan))` | **类型原型**为只读 Plan 数组，`map` 可编译 | 当前 Runtime 仍拒绝数组消费；没有实现新的解析器或工具注册路径 |

完整输入、输出、快照身份、绑定和 handler 诊断见 [当前运行原件](review-evidence/minimal-core-batch-12/results/main/current-runtime.json)；[实际作者样例](review-evidence/minimal-core-batch-12/samples/current-app.tsx) 与 [候选类型样例](review-evidence/minimal-core-batch-12/samples/candidate.type-prototype.tsx) 均保留原件。

## 当前行为与第一处缺口

当前作者需要使用另一套 Ref Tool 参数 DSL：`type:'reference' / required:true / refSource:'snapshot-value-v1'`。handler 的实际类型是递归只读 `Record<string, unknown>`，不是 Plan；访问 `plan.title.toUpperCase()` 的独立反例返回 TS18046。`refType` 也不推导业务字段。Planning 的 `Plan:` 前缀属于 ID；本次真实 DOM Producer 的描述符 `refType` 全为 `unknown`。

Planning 原组件没有渲染整份数组的 formatter，因此正文没有数组整体链接。本探针使用公开 Host 投影策略：保留 View 正文并授权该 View 的全部已注册 Ref。真实 Observation 的 refs 元数据包含整体数组；**正文未显示其链接不能直接推导它未被授权**。没有修改真实组件来补链接，也没有声称实际 Driver 一定会把这些元数据传给模型。

主树与锁定的 SRT 普通工具入口都在定义阶段拒绝当前已有的 Ref 注解，完整错误一致：`TOOL_SCHEMA_UNSUPPORTED`，路径 `$.properties.plan["x-aotui-ref"]`。这早于注册、授权和业务执行。证据见 [主树入口](review-evidence/minimal-core-batch-12/results/main/ordinary-boundary.json)、[SRT 入口](review-evidence/minimal-core-batch-12/results/srt/ordinary-boundary.json)。所以只把参数写成普通字符串，或仅增加 TypeScript 类型，都不能让普通 Tool 获得 Ref 解析能力。

候选中的 `RefValue` **只有一个未实现的声明签名**，借当前 TypeBox 的 `TUnsafe<Static<Schema>>` 表达未来希望获得的业务类型见证。它没有生成可用 Schema、没有挂载 AppTools、没有执行 handler，也没有证明 payload 已经过业务结构验证。现有 SRT 的 `ArgsOf`、bindings 与 AppTools 类型可以接住这种见证；这与运行时支持是两件事。候选 Schema 和 Plan 数据按同一个真实 Planning 类型检查；没有使用 `any`、类型断言或忽略诊断来让样例通过。

## 交负责人决定的最小差异

1. 是否采用“一份普通 Tool 定义，Ref 是参数”的方向；若采用，需要批准真实 Ref 参数表达和 payload Schema 合同。`RefValue(Plan)` 只是本次一种写法的占位，不是已批准的函数名。仅保留字符串 Schema 无法给 handler 提供可信 Plan 类型。
2. 保持既有责任分工：现有 Core 的观察/参数准备层负责按原快照、Ref grant 和来源解析；受信校验完成后，授权与执行使用相同 effectiveInput；Worker 继续检查其执行边界。App 不负责解析 Ref。当前 Ref 路径要求 View-instance，而候选沿用 App + ViewType 的共享 Tool；两者如何关联来源必须单独冻结，不能只放行 Schema 关键字。
3. 数组是否成为可消费的快照值，需要明确放开现有“非 null、非数组对象”的参数限制并验证相同来源和预算责任。发布侧已支持数组，不需要再造 ArrayRef 发布机制。多 Ref、可选 Ref 在本类型写法中可表达，但本批没有验证其运行矩阵；当前恰好一个必填对象 Ref 的合同保持。

## 身份、验证与限制

- 开工实际主树 HEAD：`8938449925ada2f92e072e1c0492af8f2428d14f`，存在原有未提交实现；没有用 HEAD 替代实际内容。锁定主树 SDK 0.3.0 / Runtime 3.0.0，292 个源码与构建输入。
- SRT 只取 `.tmp/worktrees/srt-01-m4-20261105` 的实际快照，HEAD `dde087dad13f176a273ddd5f1c3d9a212273bbdc`，SDK **0.4.0-srt01-m4.2**，294 个输入。它是该工作线的作者候选；其文档仍描述阶段审核，本批不授予 SRT 新的签收状态，也未重跑 M4 通用作者试验。
- Node **v24.15.0**、TypeScript **5.9.3**、TypeBox **1.4.3**。SDK/Runtime 分别在两个私有目录从锁定源码新构建；作者仅导入公开包入口，Host 探针使用 `@aotui/runtime`。第三方依赖复用已存在的绝对链接，未升级依赖，未做全新联网安装。
- 两组严格正例通过；现行反例 1 项诊断、候选反例 4 项诊断均符合预期，退出 2 是预期拒绝，不计作运行通过。两个普通工具入口的拒绝断言通过。真实 Worker 三场景通过，业务总进入 **2 次**、执行授权 **2 次**；全部使用原 Observation 的同一 snapshotId，递归只读检查通过。显式释放 Observation、关闭 Scope 和 Runtime 后，关闭报告成功，retainedScopes / retainedBytes / Worker pool total 为 0。
- 用保存的源码归档在第二个全新隔离目录完整复跑 **13 个命令步骤**通过，包括上述预期拒绝。完整 outcome、业务数据和 handler 值/次数与首轮一致；随机身份和时间戳各自保留，没有归一化错误、details 或业务输出。
- 保留了所有命令与中间失败：私有 pnpm launcher 的相对 `.pnpm` 路径；探针误调用 ScopeClient 不存在的 `whenClosed`；严格比较捕获对象的 null 原型；空诊断文件被误计为一行；环境清单误用 CommonJS resolve 访问仅开放 import 的入口。均只修正私有启动器或探针，失败日志未覆盖，不算核心回归或有效先红。
- 开工时 8,704 个既有文件指纹无变化；主树与 SRT 的锁定输入、Git HEAD 和 index 均保持。未运行实际 LLM/Driver、完整 Host 会话、多/可选 Ref、跨 View 归属矩阵、R4、SRT-02 或完整 Semantic 验收。

证据、实际命令、源码归档、声明原件及复跑方法见 [证据索引](review-evidence/minimal-core-batch-12/README.zh-CN.md) 与 [final-delivery.json](review-evidence/minimal-core-batch-12/final-delivery.json)。本批为只读作者样例交付，没有生产 patch，等待负责人独立复核。
