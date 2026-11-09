# Batch 17 独立复核

**APPROVED。本批签收跨页数据重名的实测和迁移评估，生产补丁为 0 字节。** 我用真实 Node Worker 让左页和右页把两份不同的计划都叫作同一个名字。指定左页，工具读到 A。指定右页，工具读到 B。读到哪份数据取决于这轮观察选中的页面实例。只拿一个数据名，还无法在这两个对象中做选择。[独立择页实测](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/owner-review/selector-matrix.json)

## 给项目所有者的决定

我建议，今后的普通工具可以只收数据名。同一 App 同一时刻，一个完整数据名只允许一个发布者使用。两个同时打开的页面把不同计划都叫作“当前计划”时，框架应指出冲突，让作者决定哪一份叫“草稿计划”等有区分度的名字。这让使用 App 的 Agent 少填一个页面参数。代价是同类页面多开时，作者需要给同时展示的对象取不同的名字。检查冲突、验证读取权限和拒绝过期调用由框架承担。

另一种可行规则是允许跨页重名，每次取数据时都带上可以从页面或工具说明中找到的页面身份。同类页面可以复用固定名字，但一次工具调用若从两页各取一份数据，就得能分别确定每一份来自哪里。两种规则都要保留快照和授权检查。具体命名规则、冲突对当前提交的影响，以及公开接口由项目所有者裁决。[两种规则的迁移对照](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE_BATCH_17_REPORT.zh-CN.md)

## 两个不同的问题分别验证

| 在真实默认入口做了什么 | 模型或业务实际看到什么 |
| --- | --- |
| 两个同类型页面共享一个旧只读工具，工具没有选页规则。分别试两页数据名相同和完全不同 | 两组都在准备该 App 的模型上下文时报 `TOOL_TARGET_REQUIRED`，尚未进入业务。两组中另一个健康 App 都能读到自己的计划。改数据名本身不能替旧工具选择页面。 |
| 给共享工具补上已有的选页参数，让两页的 `Plan:cards[0]` 各指向一份计划 | 传正确的左、右选择值，业务分别收到完整 A、B。试件作者自定的两个值均未出现在模型消息或工具参数说明里。拿模型看得见的页面 ID 去猜，得到 `INVALID_VIEW_TARGET`，业务零进入。 |
| 保留两个页面的工具绑定，只授权读取左页的同名数据 | 选左页成功，选右页得到 `REF_NOT_VISIBLE`。执行授权回调和右页业务都没有进入。 |
| 在同一页注册两个同名发布者 | 第一次冲突发生在 `AppKernel.registerRef`，返回 `REF_ALREADY_REGISTERED`。试件用 Preact 错误边界捕获原异常，不能由此推断将来跨页冲突会只影响单页。 |

前两行来自我单独编写的五组对照，每组同时装载被测 App 和一个健康 App。对执行者提交的六个场景，我又从冻结原件重新构建，独立核对 64 次工具入口调用。其中 46 次进入 Core，31 次进入读取数据的业务函数。成功时逐项对照本轮观察、页面实例、可读数据、授权实际看到的值、业务实收与收据。更新、卸载、同名重开后，左页先后读到 A、A2、A3，右页始终读到 B。已经显式释放的旧入口均被拒绝。各场景关闭后，框架保留的 Scope 和逻辑字节、Worker 及待办任务均为零。[收据核查脚本](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/owner-review/check-receipts.py) · [独立复核原始结果](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/owner-review/final-verification.json)

## 真正的 Planning 怎样用名字

五个仓内示例 App 的 65 份生产源码中，可定位的具名 Ref 发布都在 Planning 的列表页和详情页。我分别用共享树原版 App 配它自己的 SDK、用 SRT 原版 App 配候选 SDK，走了创建计划、完成阶段、关闭详情的流程。两组各五个状态，列表与详情同时出现的三个状态都无跨页重名。把共享树原版 App 直接配候选 SDK 时，严格编译退出 2，原 App 使用的 `useViewTypeTool` 在该 SDK 已退出。当前两套作者接口仍需迁移。[两套真实 App 与混装对照](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/owner-review/real-planning.json)

我还重跑了执行者的原版 SRT Planning 流程。五次操作、六份上下文，均无同一时刻跨页重名。完成第一阶段前，“后续阶段的第一项任务”指任务 3，完成后同样的名字指任务 4。消息中的两个业务 ID 确实不同。**即使决定同一时刻名字唯一，旧工具也需要认得它看见的是哪一轮。** 实测覆盖这一个 App 的这些页面状态。外部 App 的重名比例、真实模型能否自行选对页，以及统一后的普通工具如何读多个引用，仍待验证。[原 App 的完整轨迹](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/runs/final/evidence/original-planning.json)

## 封存与复跑

早期审计直接读今天的 App 源码。我在私有副本替换一份已审过的 B13 页面，就能让旧审计失败。执行者在交付前把历史源码封存，并单独提供当前树检查。我复验了三个条件：没有当前 App 目录、当前页面与开工相同、私有页面换成 B13 且另加一份后续复核材料。三次历史审计输出逐字节一致，当前树检查准确指出唯一变化的页面。[修正前实测](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/owner-review/audit-drift-before.json) · [修正后实测](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/owner-review/audit-drift-after.json)

最终脚本 20 步均通过。独立核对全部 294 份构建输入，其中 9 份对应先前三批的候选代码，其余 285 份对应冻结原件。143 份重建声明的指纹均匹配 B16。120 份执行者新增原件逐项验明，交付清单 SHA-256 为 `9f4fb4c2b168ea63be60de7888738c690ec64aa3c71f114f42e60e7d546a06cd`。9,837 个开工既有路径与 Git 索引均匹配。空补丁 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。复跑使用已记录的本机离线依赖。[签收清单](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/final-delivery.json) · [复跑入口](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-17/README.zh-CN.md)

**下一批是 Batch 18。** 给执行 Codex 的任务是在一次连续的 Driver 会话里，让两轮模型请求使用同一个名字先后读 A、B。在第二轮请求真正抵达时，再拿第一轮留下的工具调用一次，核对它何时失效、能否进入业务。正常结束和模型出错都要看到真实收据及资源结清。生产代码只读，命名和公开接口的决策单独处理。[Batch 18 的范围、四项准出和 Codex Prompt](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE_BATCH_18_TASK.zh-CN.md)
