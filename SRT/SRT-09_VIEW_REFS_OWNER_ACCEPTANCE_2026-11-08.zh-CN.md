# SRT-09 当前小项：Ref 的 View 定位验收

2026-11-08。**APPROVED，40 个路径已采用到实际根目录。** 本项完成，不表示整个 name/id 专项或未来数据体系已经完成。

最终行为：View 内保留 `[设计阶段](Phase:completed_phases[0])`；调用传 `plan_b.completed_phases[0]`。整数组展示 `Phase[]:completed_phases`，调用传 `plan_b.completed_phases`。SDK 注册局部名，Runtime 按明确 View 定位，Worker 核对地址与来源，类型/快照/观察资格及清理合同保留。

共用 Desktop prompt、Planning Root/Tool 描述与恢复提示、当前指南同步迁移；Host 和 Adapter 仍复用同一 Runtime 指令。没有新增 parser、存储或作用域框架。

Owner 集中检查核心差异及必要证据，采用前核对 40 个路径的 before/after 身份并备份 38 个原文件；2 个新增文件原先不存在。采用保留 Owner 文档和 Git 身份，没有推送、合并或发布。采用后仅执行：

- 原 run.sh 的九模块构建段通过，未启动 Electron。
- 一条实际 SDK→Worker→Source 集成通过：两份同类型 View 的同名整数组/元素正确选择，类型展示及实际 Desktop prompt 正确，错误地址拒绝，旧观察失效，关闭 B 后 A 仍可用，最终资源释放。
- SDK typed-data-ref 的 17 项相关用例通过。
- 根目录 Planning 的 27 次调用符合预期：15 成功、6 前置拒绝、6 业务校验失败按现行合同记 unknown；12 工具均成功行使，10 对象工具使用完整 View 地址，模型业务 ID 为 0，关闭资源释放。使用私有测试目录，没有操作用户计划。

Clean 的完整相关回归为 SDK187、集成32通过；Runtime2074通过、2项既有SRT-10失败。这些是执行方证据，Owner未重复全量矩阵。Owner 本轮必要构建与检查命令累计约13秒，无新增阻断。

[Owner命令和退出码](../review-evidence/srt-09-view-refs-owner-20261108/checks.json) · [裁决与调用结果](../review-evidence/srt-09-view-refs-owner-20261108/verdict.json) · [Clean完整交付](../.tmp/srt-09-view-refs-20261108/REPORT.zh-CN.md)。精确 DELIVERY SHA256：f11647d1f9ec94e52238b3d94ae7da141c5628ed822802e6bf6d4c007e1830a6。

下一步可结束旧 Host、从根目录运行原 `./run.sh` 使用新调用规则；不要求重做上一轮人工签收。`.field`、View/App/全局作用域、基础类型体系与其他 SRT-09 治理继续留在未来 TODO，SRT-10等独立问题保持原状态。

## 2026-11-08 人工体验补记

Owner 已核对 [Clean 聊天](thread://01a1834f-f8f0-7692-ab43-3c66d959648f?hostId=local) 中用户提供的六场景报告（turn `01a1bb6b-3d9e-7de0-a9d4-94f9dc9366d1`，message `01a1bb6b-3e19-7e42-8b99-f7a6d4ce1d5d`），以及用户随后“命令行里找不到日志了”的回复（message `01a1bb6d-47a2-7b71-aa73-6cb5c3c53c06`）。以下均为用户报告的体验，不是 Owner 新运行或独立观察。

**主要工作流记录为：发生操作偏差，恢复后复验通过。** 用户报告展示类型与完整 View 调用地址分离正确，任务下标移动后重新选择、阶段移动、A/B 切换及页面恢复最终成功。保留其披露的一次未重读而沿用下标造成误改、恢复标题后重新执行，以及一次清理 REF_NOT_VISIBLE 后重建流程；不写成“全程没有沿用旧下标”或“六项无偏差全部通过”。可见的 completed_tasks Ref 被用于编辑且成功属于当前业务允许，不能将这个合法调用当作应拒绝的框架错误。

**三类负例的人工覆盖未确认。** 原计划分别验证缺少 View、直接使用展示类型前缀、错误 View；报告列出的却是 pending_tasks[9]、completed_tasks[1]、pending_tasks[5]，随后成功恢复的 pending_tasks[1] 也省略了 View。原始参数日志无法取得，不能确定是报告简写还是实际输入，因此既不据此认定裸名调用成功，也不将这份人工报告视为三类负例的完整执行证据。这些规则保留已有批准的真实双 View 集成覆盖，不要求重做六场景。

**清理按用户陈述记录。** 用户报告 A/B 测试计划和临时占位计划均已删除，最终页面为 No active plan / No unfinished plans，没有 PlanDetail；未触碰其他计划。Owner 未查用户数据库，空的未完成列表不扩写成独立验证过所有已完成计划或持久数据零遗留。

工程 APPROVED 与 40 路径采用结论保持，无新增已证实实现阻断。本次仅归档体验和证据边界，不追加实现、测试、新计划或数据检查；其他未来 TODO 与 SRT-10 状态不变。
