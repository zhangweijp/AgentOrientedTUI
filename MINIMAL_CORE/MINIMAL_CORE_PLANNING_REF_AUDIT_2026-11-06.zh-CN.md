# Planning 单目标 Ref 能力核对

2026-11-06。**独立结论：APPROVED，仅限本次能力核对与探针证据。** 负责人在另一个干净目录重新解包、编译并运行实际 Node Worker，6 次调用的正负结果全部符合预期。本文是 SRT-02 的有界证据与实施范围，不另建产品 TODO；不批准尚未完成的 SDK 或 Planning 迁移。产品依据为 `AGENTS.md` 第八节和 `deepseek_review.md` 的 SRT-02；B25 历史限定验收不改写。

## 结论边界

模型应从页面选中 Plan、Phase、Task，通过完整 Ref 名调用工具；业务 ID 留在 App 的对象与数据库中。页面、工具参数、Root 指令和错误恢复必须一起迁移。文件路径仍是普通业务参数。

精确 B22 SDK / B23 Runtime 已有单个必填对象 Ref 的普通工具执行链路。当前缺口是 `useDataRef(refId, data)` 不接受或传递类型，所以独立的当前 Plan、当前 Phase 发布后是 `unknown`。手写 `Plan:` 或 `Phase:` 前缀不能补上真实类型元数据。自然数组里的 Phase/Task 元素已在本次真实 Worker 中成功消费，不是只支持 Plan。

这不等于公共 SDK 作者接口已经完整。B25 的 `RefValue` 仍是 App 内的试件 helper，未从 SDK 公共入口导出；后续公共参数语法需要明确决定，不能要求普通应用作者自行理解或手写内核注解。

## 已核对的实现与职责

输入固定为 B22 SDK tar SHA-256 `c5c750464c7151e230654fcf4ae5846df4d2a02f47876d558a4a1b48257391ff`、B23 Runtime tar SHA-256 `46c39d592ce11ec950ab10dbf15568b55278d0a5c3702366feb0c443e063a7e6`。负责人重新计算两个包指纹，并记录 20 份实际源码/声明的指纹。[只读源文件记录](../review-evidence/minimal-core-planning-ref-audit-20261106/owner-review/source-audit.json)

| 事实 | 当前实际实现 | 含义 |
| --- | --- | --- |
| 单对象发布 | SDK `hooks/useRef.js` 仅调用 `registerRef(refId, data)`；声明也只有两个参数。 | 当前独立对象缺少真实业务类型。 |
| 数组元素发布 | SDK `hooks/useArrayRef.js` 将 `itemType` 同时用于完整名字及 `registerRef` 的第三参数。 | 一个真实列表里的单个元素可以携带业务类型；不据此宣称整体数组可供普通工具消费。 |
| 元数据传递 | SDK `View` → Runtime `AppKernel.registerRef` → DOM Snapshot V3 均已有 `refType` 字段。 | 补单对象发布能力有现有通道可复用，无须从名字猜类型或另建类型注册中心。 |
| 调用解析 | `prepareViewTypeParameters` 从调用绑定的原观察可见 Ref 查找，再解析原 Snapshot；比较 `refType` 并校验解析后的值。 | 模型传名字，handler 收对象；App 不手动 resolveRef，也不根据列表位置查询最新对象替代原对象。 |
| 普通参数限制 | 当前 qualified profile 只接受零个或一个必填顶层对象 Ref。 | 可带普通编辑字段；可选 Ref、多个 Ref、Ref 数组、整体数组消费均不包含在本次支持声明中。 |
| App 对象定位 | Planning 已有 `findPhaseLocation`、`findTaskLocation`；数据库对象 ID 为主键，并保存父子关联。 | 业务 ID 仍有内部用途；不需把它们交给模型，也不需新增身份映射层。 |

Phase/Task handler 应先在当前 activePlan 的业务树中确认对象仍存在且归属正确，再调用既有 action。数据库还保留 desktop 归属校验。不能拿到 payload.id 就绕过当前 Plan 检查直接调用数据库；Runtime 不推断业务父级或权限。

## 逐工具的下一候选范围

| 工具 | 模型选择已有对象的方式 | 仍由模型提供的普通输入 | App 必须保留的检查 |
| --- | --- | --- | --- |
| `create_plan` | 不选择已有对象。 | 标题、说明、初始阶段/任务。 | 创建字段有效性。 |
| `open_plan` | 一个必填 Plan Ref，B25 已局部接通。 | 无。 | 该计划仍存在，符合列表可选规则。 |
| `update_plan`、`delete_plan` | 一个必填 Plan Ref。 | 更新时的标题、说明。 | 计划存在及当前可操作规则。 |
| `close_plan` | 无参数，关闭应用明确的唯一活动计划。 | 无。 | 当前确有活动计划。 |
| `add_phase` | 一个必填 Plan Ref。 | 标题、说明、初始任务。 | 该计划仍是当前活动计划。 |
| `delete_phase`、`complete_phase` | 一个必填 Phase Ref。 | 无。 | 阶段仍属于当前活动计划。 |
| `add_task` | 一个必填 Phase Ref。 | 标题、说明。 | 阶段仍属于当前活动计划。 |
| `update_task`、`delete_task`、`complete_task` | 一个必填 Task Ref。 | 更新时的标题、说明。 | 任务仍属于当前活动计划中的阶段。 |

共 12 个工具，其中 10 个选择已有对象；每个只需一个目标 Ref。`update_plan` / `delete_plan` 移除“省略目标即 activePlan”的旧分支，这是 SRT Owner 已记录的下一候选应用合同变更，不声称兼容，也不为保留旧分支扩大 optional Ref 协议。

当前 Plan、详情 Plan、当前 Phase 应发布真实对象及明确类型。无对象时，沿用 B13 已证明的条件子组件模式，组件不存在即不发布 Ref，不用只有标题的占位对象，也不用单元素数组冒充单对象支持。页面去掉额外的内部 ID 展示，保留标题、说明、状态和完整 Ref 名；错误提示引导观察当前页面并重选对象。

## 所需的最小 SDK 能力

执行链路只需要现有 `useDataRef` 将显式业务类型传入现有 Registry；formatter 生成的完整名字必须与真实注册键一致，值更新复用原 binding，名字/类型变化或卸载时释放原 binding。现有重复发布所有权检查与 cleanup 语义继续负责隔离和释放。

本次探针复核后，SRT Owner 选择下一隔离候选使用 `useDataRef('current_plan', plan, { refType: 'Plan' })` 和公共 `refParam(refType, valueSchema)` 两个薄入口。后者仅包装已验证的参数标注，handler 类型从 Schema 推导；不增加全局类型描述符或第二套解析。**这是本地候选的实施选择，不是正式公共 API 签收、发布或共享采用。** 本次探针本身仍使用已签收的局部 `RefValue`，不能据此宣称新的 SDK 公共导出已完成。

此处不需要新 Runtime wire、状态管理器、业务 ID 映射、手动参数解析或新的资源管理体系。是否确实只需 SDK 变化，由下一隔离候选的包消费者及 Worker 实测验证，不能以静态推断代替准出证据。

## 真实验证与未覆盖项

执行者使用新目录 `.tmp/minimal-core-planning-ref-audit-20261106/`，负责人使用另一个 `.tmp/minimal-core-planning-ref-owner-replay-20261106/`。负责人对两份 tar 重新解包，并逐项对比 SDK 90 件、Runtime 388 件 payload 与执行者安装内容，编译作者 fixture 后运行真实 createTUIApp、Node Worker 和 Source。[独立复跑脚本](../review-evidence/minimal-core-planning-ref-audit-20261106/owner-review/replay.py) · [独立复验记录](../review-evidence/minimal-core-planning-ref-audit-20261106/owner-review/replay-verification.json) · [实际 Context、wire、业务与关闭结果](../review-evidence/minimal-core-planning-ref-audit-20261106/owner-review/result.json)

| 实际调用 | 实际结果 | Worker 派发 / 业务进入 |
| --- | --- | --- |
| 选自然两项 Phase 列表的第二项 `Phase:phases[1]`，附普通 title。 | 完整 Phase，包括两项 tasks/todos，与原对象逐字段一致；业务输入冻结。 | 1 / 1 |
| 选该 Phase 自然两项 Task 列表的第二项 `Task:phase_tasks[1]`，附普通 title。 | 完整 Task 与原对象逐字段一致；业务输入冻结。 | 1 / 1 |
| 把 Phase Ref 传给 Task 参数。 | `REF_TYPE_MISMATCH`。 | 0 / 0 |
| 原两参数 `useDataRef` 发布 `single_plan`，交给 Plan 参数。 | `REF_TYPE_MISMATCH`；实际目录为 `single_plan (unknown)`。 | 0 / 0 |
| 把实际注册名写为 `Plan:prefixed_plan`，仍用两参数 `useDataRef`。 | `REF_TYPE_MISMATCH`；实际目录仍为 `Plan:prefixed_plan (unknown)`。 | 0 / 0 |
| 只把显示链接改成 `Plan:single_plan`。 | `REF_NOT_VISIBLE`；没有对应注册记录。 | 0 / 0 |

两个正例的普通 title 特意填入看起来像 Ref 的字符串，业务实际原样收到，证明普通字符串没有被全局自动解析。每个正例的 V4 `effectiveArgs` 与业务输入逐字段相同，`refSources` 的类型和完整名字与实际页面选择一致。Context 释放后 scope、observation、lease 归零；最终 `close.ok` 与 `resourcesReleased` 均为 true。未使用 Host、GUI、Driver 实例或真实 LLM。引用既有 Driver 编译包仅用于 Source 的工具/schema 依赖，不据此宣称当前共享 Driver 整条链被验证。

本次不是完整 Planning 迁移、真实 LLM 理解测试或最终 Semantic 验收。数组整体、多 Ref、可选 Ref、采用新观察后自动撤销旧资格仍按既有专项管理。Host 首次预览刷新缺陷 MC-HOST-PREVIEW-01 保持 OPEN，另行定位。冻结 B25 环境、私有状态和旧证据不得修改。

## 后续执行 Prompt 与分工

先完成 typed 单对象发布和公共 `refParam` 的最小隔离候选，再按上述矩阵迁移 Planning 的页面、Schema、Root 和错误恢复。执行 Codex 独占 `.tmp/minimal-core-typed-ref-sdk-20261106/` 的 SDK 实现、定向测试和本地包；SRT Owner 负责另一个新目录内的 Planning 迁移；Minimal Core 负责人独立复核 SDK 和应用交付。证据位于 `review-evidence/minimal-core-typed-ref-sdk-20261106/`，其 `owner-review/` 留给独立复核。各自不得覆盖其他工作者的修改。

SDK 以签收 B22 来源重建基线；Runtime 固定使用本次核验的 B23 原包，不改 wire 或重建 Runtime。复用已有绑定、投影与调用路径，不加 Ref 类型注册中心，不在 App 手动解析 Ref，不用单元素 ArrayRef 补缺口。需要新增范围时提交实际失败和最小修改依据。新 tar、声明差异、可重放 patch 及测试证据必须独立签收后才算候选可用。

SDK 准出须证明真实单对象的完整名字/类型/payload 一致、值更新、名字/类型变化、卸载清理及重名所有权检查；同一 Runtime 包实际接收对象，错误类型或无授权名字在业务前拒绝。App 准出须覆盖全部 12 个工具，模型输入不再含定位用业务 ID，Plan/Phase/Task 的真实修改结果经 View 可见，跨计划、对象删除、切换活动计划和缺省必填目标均正确拒绝；普通标题/正文等字段继续正常使用。独立复核后分别裁决，不将开发者自测当作批准，不扩大数组、多 Ref、optional Ref、Host 预览或共享采用范围。
