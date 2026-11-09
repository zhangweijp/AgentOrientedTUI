# Typed Ref SDK 与 Planning 单目标迁移独立复核

2026-11-06。**SDK 候选：APPROVED。Planning 迁移候选：APPROVED。结论仅限下列精确本地隔离产物。** 负责人独立阅读 patch、实际源码与声明，并在自己的目录重建、运行测试和真实 Worker 消费者。开发者没有自行批准自己的交付；本次不代表共享代码采用、正式公共 API 发布、SRT-02 整体完成或所有者最终 Semantic 验收。

## 实际改变

SDK 在现有 `useDataRef` 增加显式 `refType` 选项。`useDataRef('current_plan', plan, { refType: 'Plan' })` 的页面链接与注册名都为 `Plan:current_plan`，实际元数据也为 `Plan`。值变化更新原 binding；名字或类型变化释放旧 binding；卸载释放当前 binding。全空白类型被明确拒绝，不会再悄悄发布为 `unknown`。原两参数调用继续使用原名字与未标类型记录，不从名字前缀猜类型。

新增公共 `refParam(refType, valueSchema)` 只是既有 TypeBox 参数注解的薄入口，主入口与 `@aotui/sdk/tools` 导出同一个实现。业务函数的输入类型从 Schema 推导为只读对象，模型输入仍是完整 Ref 字符串。Schema 的安全捕获、支持范围校验、原观察解析和执行授权继续使用原有路径，没有新增注册中心、解析器或 Runtime wire。

Planning 删除 App 内的 `RefValue` helper、样机数据、额外业务 ID 展示和原来的 ID 选目标参数；页面、Schema、Root 说明及错误恢复一起迁移。12 个工具中，10 个选择已有对象的工具使用一个必填 Plan、Phase 或 Task Ref，编辑标题等仍是普通参数。`create_plan` 继续接收创建内容，`close_plan` 继续关闭唯一活动计划。当前对象不存在时不再发布占位对象。

业务 ID 仍留在 App 数据与 Ref payload 中。handler 从当前活动计划的业务树确认存在与归属后再调用原 action；`PlanningApp` 状态管理、业务服务、数据库及原数据类型均未改变。文件路径规则未改变。

明确的应用合同变更：`update_plan` / `delete_plan` 不再支持省略目标即使用活动计划。Phase/Task 来自另一个计划时，现在返回 `PHASE_NOT_FOUND` / `TASK_NOT_FOUND`；没有活动计划及 `add_phase` 目标不是当前计划仍返回 `PLAN_NOT_ACTIVE`。这些业务错误继续使用既有的 `unknown + error.code` 映射，本次没有改 Runtime 结果分类。

## 精确产物与源码范围

| 产物 | SHA-256 | 实际用途 |
| --- | --- | --- |
| 最终 SDK 本地包 | `7573cc0b73d1aa480edf68847617da1d9c85e4bab616bfebfd5b6f124baa5e5b` | SDK 独立消费者使用的最终包。 |
| SDK 首包 | `4cdb78f2abe6ee847c58b2b0515d5c842faa9560e32a2021267b988f30328344` | Planning 开发者及负责人实际重跑使用。与最终包唯一差异为 README，全部执行代码及声明逐字一致；原件保留。 |
| 固定 B23 Runtime | `46c39d592ce11ec950ab10dbf15568b55278d0a5c3702366feb0c443e063a7e6` | 全部调用使用此原包，未重建或修改 Runtime。 |
| Planning 本地包 | `ac41d296facd7503d5838a57dc0507aee3c1a32e9beba576505143d88e8140c1` | 46 件包内容与负责人重建产物核对；package.json 仅有已记录的 pnpm 打包规范化。 |

SDK patch 为四份生产源码（Hook、已有 Tool 声明模块、两个公共导出），另有 README 与五份测试/类型输入，共 10 个文件。负责人在仓库外的独立临时目录实际应用 patch，10 个结果全部与自己编译的源码指纹一致；生成的 76 件 dist 文件与最终 SDK tar 一致。[SDK patch](../review-evidence/minimal-core-typed-ref-sdk-20261106/SDK_TYPED_REF.patch) · [独立 patch 与首末包核验](../review-evidence/minimal-core-typed-ref-sdk-20261106/owner-review/patch-verification.json)

Planning 的改动集中在页面、工具合同、数据 Schema 和对应测试。负责人核对了 63 件源码/测试/产物、46 件打包内容、实际消费者脚本，以及四份业务核心文件与冻结基线不变。[App 对照 patch](../.tmp/planning-ref-only-20261106/evidence/planning-app.patch) · [App 产物独立核验](../review-evidence/minimal-core-planning-ref-migration-20261106/owner-review/artifact-verification.json)

## 独立运行结果

| 验证 | 负责人实际结果 |
| --- | --- |
| SDK 构建与相关回归 | 源码重新编译成功；8 个测试文件、91 项通过，覆盖值更新、改名、类型切换、卸载、重名和旧 cleanup 不删除后继发布者。 |
| SDK 公共类型与真实包消费者 | 均以 strict、skipLibCheck:false 编译通过；SDK 公共类型另启 exactOptionalPropertyTypes。handler 输入为对象且只读，错误的字符串业务输入和写入操作由类型断言拦截；不据此声称全仓所有测试通过。 |
| SDK 真实 Worker | 6 次串行调用：完整单对象 Plan 与自然数组 Phase 各执行一次，错误类型、旧未标类型、空 Ref、不可见名字共 4 次均在派发前拒绝。普通字段即使长得像 Ref 也原样保留。 |
| 参数合同矩阵 | 11 条结果与原局部注解基线逐字一致。可选、多 Ref、整体数组及 Ref 数组仍由现有 Runtime profile 明确拒绝；Schema getter 调用次数为 0。 |
| Planning 构建与测试 | 标准编译、aoapp 生成、4 个测试文件共 15 项全部通过。应用沿用原 tsconfig 的 skipLibCheck:true，与上面的 SDK 公共类型检查分别记录。 |
| Planning 真实 Worker | 27 次调用：15 次成功，覆盖全部 12 个工具；6 次框架拒绝为 0 Worker 派发；6 次 App guard 为 1 次 Worker 派发后明确业务错误。 |
| 对象身份与页面结果 | Task 数组移位及当前 Phase 更换后，合法持有的旧观察仍交付原对象；原对象删除或切换活动计划后不会误改新对象。修改后页面显示新内容，关闭后 7 个详情工具退出。 |
| 模型可见合同 | 实际 View/Root 不显示实例业务 ID；10 个目标参数都是必填字符串 Ref，普通内容字段保留。 |
| 关闭与资源 | 两套独立消费者最终 scope/lease 清理及 `close.ok`、`resourcesReleased` 均符合预期。 |

SDK 独立目录为 `.tmp/minimal-core-typed-ref-sdk-owner-03-20261106/`；Planning 独立目录为 `.tmp/planning-ref-only-owner-20261106/`。这些运行没有访问冻结手测数据库或使用真实凭据。[SDK 独立运行记录](../review-evidence/minimal-core-typed-ref-sdk-20261106/owner-review/replay-verification.json) · [SDK 实际 Context/调用结果](../review-evidence/minimal-core-typed-ref-sdk-20261106/owner-review/result.json) · [Planning 独立运行记录](../review-evidence/minimal-core-planning-ref-migration-20261106/owner-review/replay-verification.json) · [Planning 实际 Context/27 次调用](../review-evidence/minimal-core-planning-ref-migration-20261106/owner-review/result.json)

## 保留的失败与未覆盖项

- 原签收 SDK 的两份旧测试 fixture 仍声明 v1 port，造成原基线 27 项失败；原公共类型 fixture 还将工厂协议期望为 v1，产生 1 个 TS2322。只将这三个测试字面量同步为已签收的 v2 后，基线 76 项及严格类型检查通过，候选 91 项通过；没有删除原断言或改生产协议。历史失败保留。
- SDK 执行者的中间消费者有错误的预期 code/统计字段；负责人前两次重建也分别遗漏测试资源和 Runtime 局部依赖。所有原失败保留，修正只发生在脚手架，最终新目录重跑通过。[负责人脚手架修正记录](../review-evidence/minimal-core-typed-ref-sdk-20261106/owner-review/setup-correction.json)
- Planning 第一轮脚本保留过多观察，触发现有容量保护。修正为只保留身份核验所需的观察后通过，未扩容。负责人复跑使用修正后的精确脚本。
- 新 Hook 的发布输入错误目前为 `TypeError` 与具体说明；既有工具声明诊断仍沿原稳定 code/path。本次没有完成统一错误治理。
- 本次仅实现一个必填顶层对象 Ref。数组整体、多 Ref、可选 Ref、旧 Snapshot Tool 退出和新观察采用后自动撤销旧资格均没有因此完成。测试显式保留/释放旧 Context，不能替代 SRT-05。
- 页面验证使用有界的测试条件等待，不承诺每个调用后的第一次观察必然已有新页面；未为此加入生产延迟、轮询或 App 补偿逻辑。
- 当前 Tool Schema 仍带原 `x-aotui-ref-value` 校验元数据，其中含 `id` 字段的类型声明；没有向模型展示实例 ID，但也没有完成元数据裁剪。
- 未使用真实 LLM。新的 GUI 补验由 SRT Owner 独占，当前因 Mac 锁屏等待解锁，尚无本候选 GUI 通过结论。MC-HOST-PREVIEW-01 首次预览刷新问题仍单列 OPEN。
- 共享工作树含不同于旧候选基线的保护，须沿 B24 的采用审查另行集成；不能直接覆盖共享 SDK/Runtime/Host，也未发布包或替代所有者 Semantic 验收。

## 下一步范围、准出与执行 Prompt

下一步先完成这组精确包的独立 GUI/手测入口补验。SRT Owner 已准备新的无凭据副本 `.tmp/planning-ref-manual-20261106/` 并独占 GUI；Mac 解锁前不伪造通过或另起竞争操作。SDK 执行者完成封存后不启动其他生产改动。

准出：实际 GUI 请求中的对象目标来自当时页面的完整 Ref；创建/修改后能观察到对应页面结果，关闭后详情和相关能力退出。准确记录是否需要切换 Chat/TUI，以及首次预览是否仍陈旧；受控 provider 只证明工程链路，不宣称真实模型理解。原 B25 和新旧私有状态保持隔离，三份精确包不漂移；GUI 结果由另一负责人复核。

给后续 Codex 的 Prompt：复用已准备的新副本及本报告精确 SDK/Runtime/Planning 包，在获准 GUI 操作条件恢复后验证“创建计划 → 从实际页面选择任务 Ref → 修改任务 → 观察更新 → 关闭计划”。模型原始输入不得夹带业务 ID、对象 payload 或测试直接填入的工具执行结果；记录实际请求、收据、页面、工具退出和关闭证据。不要修 Host 预览、改 Ref wire、增加 App 延迟或轮询，不启动多 Ref/可选 Ref 等范围。若预览仍失败，保留原始事实并交 MC-HOST-PREVIEW-01 单独处理；交 READY_FOR_REVIEW，由独立负责人裁决。真实 LLM 使用与最终 Semantic 仍由所有者验收。
