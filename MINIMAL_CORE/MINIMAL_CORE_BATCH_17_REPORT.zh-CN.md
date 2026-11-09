# Minimal Core Batch 17 交付报告

**READY_FOR_REVIEW。本批只取证，没有修改生产代码。** 两页可以发布逐字相同的 `Plan:selection[0]`，分别指向 `plan_A` 和 `plan_B`。现有只读工具按已观察的页面实例取值，不会仅凭这个名字在整个 App 中挑一份。与此同时，“工具怎样选页面”和“数据是否重名”是两件事：同类型多页共用一个旧只读工具、没有选择规则时，即使引用名字不同，也会被拒绝。后者的异名对照来自负责人独立证据，未计作执行者重跑。

## 1. 输入、边界与复跑

任务书 SHA-256：`23207bbe182b8883390189b8fbe73833a17b6b6e088cdeaa89af9fc34cae7b4b`。本批以 Batch 12 封存的 294 份 SRT 输入，依次应用签收的 B14 R1、B15 R1、B16 补丁，在私有目录重建 Runtime 与 SDK。三个 patch 的指纹逐项校验并通过正向检查。组合仍使用现有 `useViewSnapshotTool` 只读执行链；这不表示普通 ViewType Tool 的 Ref 参数已上线，也不构成正式包采用或发布验收。

开工时保全实际工作树的 **9,837 个既有路径**、Git 状态、HEAD 和 index；没有用 HEAD 代替当前内容。真实 App 的 14 份原始输入另行封存。静态审计补封存 65 份主树 App 源码，逐份匹配原开工指纹，原 `baseline.json` 和已有 runs 没有回写。最终保护核对见证据目录的 `protection.json`。负责人本批并行证据单列为外部新增，不计作本次自产材料；既有根目录缺失及历史清理均按开工现状保留。封存时另见 Batch 18 任务书与两份 planning 证据新增，未读取其内容或计入本批贡献，单列外部变化。

环境为 Node **v24.15.0**、pnpm **10.15.1**、Python **3.14.0**，使用已存在的 TypeScript 5.9.3、TypeBox 1.4.3、Preact 10.29.1、sql.js 1.13.0。实际依赖路径和 package.json 指纹在最终运行的 `dependency-resolution.json`。无安装、依赖升级或锁文件修改。复跑需要这些已记录的本机离线依赖及被引用的历史原件。

在项目根目录运行：

```sh
python3 review-evidence/minimal-core-batch-17/reproduce.py
```

最终 **20 步均退出 0**：六项签收 patch 检查/应用、Runtime/SDK 重建、`strict: true / skipLibCheck: false` 私有试件编译、六种 Worker/Source 场景、原有 Planning App 编译和运行、封存源码审计、私有 B13 漂移验证、完整记录核对。逐路径比对了 143 份生成声明的 SHA-256，全部匹配 B16 已签收候选记录；没有把仅有哈希的项称为已保存声明原件。最终命令、执行目录、标准输出、标准错误和退出码均保存于 `runs/final/evidence/commands.json`，未把历史测试数量算成本次执行。

生产补丁 [MINIMAL_CORE_BATCH_17.patch](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE_BATCH_17.patch) 为 **0 字节**，SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。没有生产 hunk 可应用；保护核对和签收组合的源码、声明指纹提供只读证据。

## 2. 真实调用结果

主链是实际编译 App → Node Worker → Runtime Snapshot/Scope → 默认 `SemanticAOTUIDrivenSource.getContext()` → **该 Context 的 `executeTool()`** → Core/Worker/SDK → 业务函数。没有改写工具路由、查询最新 AppKernel Map、模拟 Ref 解析或放宽授权。只读记录器委托原有 policy/ScopeClient 方法，原参数和返回值保持；记录的是观察捕获的 source，不是另一份解析数据。另一个明确标记的自定义 Host policy 场景仅用于未授予数据的对照。

| 场景 | 实测结果 | 调用数 / 只读业务进入数 |
| --- | --- | --- |
| 两页不同 ViewType，名字分别为 `Plan:left[0]`、`Plan:right[0]` | 同一轮消息展示两页和各自工具。各工具读到本页完整 A/B；拿另一页名字调用得到 `REF_NOT_VISIBLE` | 17 / 8 |
| 两页不同 ViewType，同名 `Plan:selection[0]`、同为 Plan | 左工具读 A，右工具读 B。完整对象、业务实收、授权 effectiveInput、Ref 来源、Snapshot 和 View instance 一致；不是只比 ID 或 status | 15 / 8 |
| 两页同 ViewType，同名，未声明 target | Scope 观察成功；Source 在构造 App 投影时首报 `TOOL_TARGET_REQUIRED`，App 页面及 App 工具不发布，业务零进入。是工具目标歧义，不是数据重名错误 | 0 / 0 |
| 两页同 ViewType，一个 inspect，使用已有 target 参数 | 通过 `page` 选到对应绑定，分别读 A/B；缺少或传不存在的选择值得到 `INVALID_VIEW_TARGET`，授权与业务均零进入 | 17 / 8 |
| 自定义 Host 授权扣除确实存在的 `Plan:ungranted[0]` | 默认对照中可读；限制场景中返回 Core `not-dispatched / REF_NOT_VISIBLE`，执行授权 0、业务 0、结果读取授权 1。为合法扣除 grant，相应页面内容按现合同隐藏；此场景不是默认 Source 的可见范围 | 15 / 7 |
| 同一页两个发布者发布相同数组名 | 原始 `RefRegistrationError / REF_ALREADY_REGISTERED`，首个冲突是 `Plan[]:selection`，栈定位到 `AppKernel.registerRef`。试件用标准 Preact ErrorBoundary 记录原异常，业务 0；不把试件边界解释为框架承诺单页隔离 | 0 / 0 |

上述为 **64 次 Context 执行入口调用**，含 31 次只读业务进入、12 次试件控制工具执行、21 次拒绝。执行授权共 43 次，结果读取授权 46 次。每次只读成功都比对完整 effectiveInput 和业务对象，检查递归冻结及来源绑定；失败则核对业务和授权次数。原始 Core 收据、完整消息/工具 Schema、输入、授权事实和业务值未归一化，见六份模式 JSON 与 `verification.json`。

四个可读场景都串行执行：初始 A/B → 左更新为 A2 → 左卸载 → 左同名重开为 A3。右页四次均为完整 B，且 **View instance 一直相同**。左更新保持原实例，重开使用新实例。每次旧 Context 显式 release 后调用被拒绝；同名后继已可用时再次调用最初释放的 Context，仍为 `SEMANTIC_CONTEXT_RELEASED`，授权、读取授权、业务均为 0。没有据此定义新观察采纳时点，也没有测试或改变尚未释放 Context 的新语义。

六个场景与真实 App 结束时都确认：关闭成功、受管资源释放，保留 Scope、逻辑字节、Worker pool total、pendingTasks 均为 0。未额外声称检查了没有单列在本次输出中的所有资源计数。

**负责人独立补证的作者负担。** [selector-matrix.json](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/owner-review/selector-matrix.json) 的五组真实默认 Source / 限定授权对照另行固定引用：

- 缺 target 规则时，同类型两页使用异名或同名都报 `TOOL_TARGET_REQUIRED`；健康的另一个 App 仍可使用。因此全局改成不同数据名，也不会自动解决现有旧工具的页面选择问题。
- 作者把选择值设为 `opaque-sand-17 / opaque-fern-29` 时，默认消息和实际工具 Schema 都未自动公布它们；Schema 只有 string，没有 enum。猜页面 ID `left` 得到 `INVALID_VIEW_TARGET`；传确切值才读到 A/B。作者当前还得把可选值写进正常指引或 Schema，不能认为框架已替模型提供。
- 即使左页同名对象已获授权，选择右页的未授予对象仍为 `REF_NOT_VISIBLE`，执行授权与业务均为 0。名字相同不共享可读资格。

这些是本次读取并校验指纹的负责人原始证据，未计入本次 64 次调用或 20 步执行数，也未声称由执行者独立重跑。

## 3. 真实 App 的迁移影响

静态审计覆盖开工主树五个 App 的 **65 份生产 JS/TS**，查看直接 Ref API/标记及 SDK 导入。只有 Planning 的 PlanListView 和 PlanDetailView 命中实际 Ref 发布，共九个调用点，其中一个动态子组件重复使用。IDE、Browser、Terminal、TokenMonitor 未发现上述范围内的具名数据发布；Terminal/TokenMonitor 的 `useRef` 是 SDK 重导出的 Preact 状态 Hook。此搜索不能证明外部 App 或其他 Producer 都不存在重名。

Planning 原有名字分布如下：列表页发布 `active_plan`、`unfinished_plans`；详情页发布 `plan_detail_current`、`current_phase`、`completed_phases`、`pending_tasks`、`completed_tasks`、`upcoming_phases`；未开始阶段各自使用 `upcoming_phase_${index}_tasks`。根组件始终保留 Root 和列表，最多同时保留一个详情。这组固定名字在所见组合中不冲突。

实际运行的是**未改写的 SRT 工作树 Planning 完整 App 原件**，不是只渲染借来的列表组件或重建业务 helper。14 份源码/配置/锁文件逐份检查原件指纹后私有编译，使用原 Root/List/Detail 组合、原 Tool 绑定、原 service 与 sql.js；数据库仅位于私有复制 App 的 `data/planning.sqlite`。通过默认 Source 的原工具创建 A（三阶段和任务）、完成第一阶段、创建 B、关闭详情、重新打开 A，共 **5 次成功工具调用、6 份上下文**，同时页面数为 **2 / 3 / 3 / 3 / 2 / 3**，跨页重复最终 Ref ID 每次均为空。

动态名字有实测边界：`Task:upcoming_phase_0_tasks[0]` 先显示 Task 3，第一阶段完成后显示 Task 4；同一名字会随列表位置更新，不是永久业务身份。这是时间上的复用，并非同一观察中重名。详情关闭和重开也按原组件运行。当前主树 App 与 SRT 的 Tool 作者 API 不同，本批只静态审计主树，**不宣称当前主树五个 App 都已在候选组合运行或全量验证**。Planning 现有业务工具主要使用 `plan_id / phase_id / task_id`，未把具名 Ref 自动当作已统一的普通工具参数。

## 4. 给上级的命名范围对照

以下表中“现状”由上述调用证明；“方案”是待决定合同的推论，本批均未实现。

| 决策项 | 同一 App 当前提交内 RefName 唯一，冲突明确拒绝 | 名字由页面区分，调用必须确定页面身份 |
| --- | --- | --- |
| 解析依据（方案） | 当前 Observation/App instance + 完整名字；仍检查该具体来源的 grant | 当前 Observation/App instance + 确定的 owner View instance + 名字；公开名字本身可以不含 View ID |
| 在哪里检查（方案） | 沿现有注册所有权记录拒绝不同发布者占用同名，并在提交/捕获边界验证；不另建注册中心，不交给 App 自检 | 延续同页重名保护；解析时使用观察内绑定的 owner。不能到最新 Map 后缀查找、取第一项或自动换后继 |
| 冲突影响范围 | 当前跨页允许的重复会成为发布失败。应保留既有 App 隔离；新方案究竟拒绝提交、保留上次状态还是标记某页，尚未实测/决定，不能承诺只影响冲突页 | 跨页同名允许；同页仍拒绝。现有同类型旧工具目标不明确会隔离整个 App 投影；健康 App 不受影响是负责人实测 |
| 对现存作者的影响 | 所测 Planning 组合无需因重名改名；多实例模板固定名会需要 App 内不冲突的名字。不能根据一个样本推导所有 App 无迁移成本 | 模板可沿用固定名字，但框架须把足够的页面身份呈现并随调用绑定。当前 target 的任意选择值不自动出现在消息/Schema，作者需要提供可发现的值并处理错误 |
| 共用工具与多个引用参数 | 唯一数据名不等于唯一工具执行目标；现有旧只读工具的多 owner target 要另行迁移。新普通工具扩大到 App 范围解析也是范围变化 | 现有一个 target 可确定该工具的一个 owner；若未来一次工具从不同页取多个 Ref，不能把一个页面选择参数当作所有来源，需给各参数明确身份合同 |
| 能否避免错取（方案） | 不同发布者重名拒绝后，可避免按相同名字默取另一页；但仍必须验证观察、来源、授权与存活 | 明确 owner 后，同名可确定取到对应对象；无效/未授予/已撤销的来源必须拒绝。传了合法但意图错误的 owner，框架不能替调用者推断另一种意图 |
| 必须保留 | 两种方案都保留 publisher token、App/工具实例身份、观察快照、权限、结果读取、释放与失败反馈；名字不成为权限或永久对象身份 | 同左。不得让每个 App 作者自己实现归属校验 |

如果模型最终只传完整 RefName、没有页面身份，App 内唯一并明确拒绝冲突是自洽选择；如果保留多页同名，就必须把页面确定性写入可观察的调用合同。**仅改变命名范围不能完成旧工具退出或普通多 Ref 工具迁移。** 具体 API、失败影响面与正式迁移归上级另批裁决。

## 5. 失败记录、可复跑性与未执行项

`runs/01`、`runs/02` 保存两次失败的完整命令、输出、探针版本和原始记录。第一版记录器对冻结 ScopeClient 使用了不符合 Proxy invariant 的包装；第二版还存在试件 app_name 含横线、卸载后错误地要求旧上下文有左工具，以及扣除 Ref grant 却 retain 整页的无效自定义投影。这些是探针错误，没有作为产品缺陷或有效先红。只修探针后，原业务完整链路通过；无生产修复。`runs/03`、`runs/04` 保留后续通过版本，最终版本在 `runs/final`。

负责人还独立复现默认审计读取当前工作树、会被合法 B13 页面更新中断的问题（`owner-review/audit-drift-before.json`，固定引用）。封存前已修正：默认审计从 65 份主树源码原件和已封存 SRT App 解包，负责人事实也仅引用固定五份原件；后续新增复核文件不会进入历史输入。独立当前树检查另行报告漂移，不作为历史复跑前置。

`audit-drift-after.json` 用私有 65 文件副本替换相同的已签收 B13 PlanList 页：默认审计前后均退出 0，**完整输出逐字节一致**；当前树检查前为 MATCH/退出 0，之后只报告那一页 DRIFT/退出 1（预期）。未改共享生产、历史材料或已保存 runs。原始基线未回写。本批尚未封存过 READY 版本，因此此反馈纳入首次交付。

保护门禁曾因上述三份外部新增尚未归类而退出 1；原脚本、完整错误与处理保存在 `logs/seal-initial-rejection.json` 等文件。9,837 个既有路径未变化，外部文件未恢复、删除或改写。

未执行：真实 LLM 自动选择页面实验、所有 App 全量运行、普通 ViewType Tool 多 Ref 的正式在线迁移、跨包混用、并发命名、观察采纳新规则、正式包发布及完整 Semantic 验收。本批没有新增永久测试、修改公共 API、实现新命名策略、自动前缀或跨页解析。

报告、独立空补丁、证据索引与 `final-delivery.json` 一并提交负责人独立复核，状态保持 **READY_FOR_REVIEW**。
