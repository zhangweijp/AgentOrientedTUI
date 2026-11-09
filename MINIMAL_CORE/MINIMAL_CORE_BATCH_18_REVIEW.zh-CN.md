# Batch 18 独立复核

**APPROVED。签收的是现有串行会话的实测，生产补丁为 0 字节。** 一个 Driver 连续请求两轮。列表第一项从计划 A 换成 B，两轮使用同一个数据名，各自读到了当轮页面显示的计划。上轮的工具在第二轮取得页面前就已失效。框架此时仍保留旧快照的完整内容。这个现象与旧观察专属数据应及时释放的目标存在差距，已列为本版本最终验收前的待决项。[独立复核记录](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-18/owner-review/final-verification.json)

## 第一轮工具究竟何时失效

我从冻结源码重建 Driver、SDK 和 Runtime，使用实际模型 SDK、默认 Source 和 Node Worker。第一次请求向模型展示 A。受控模型先要求读第一项，再要求重排。Worker 业务函数读到 A，重排使 Runtime 发出一次更新。Driver 交付两份收据，释放第一轮上下文，再获取第二轮页面。第二次请求实际抵达传输函数时，重用第一轮的入口得到 `SEMANTIC_CONTEXT_RELEASED`，授权、Core 调用和业务进入均为零。随后第二轮用相同的名字经过新入口，Worker 读到完整的 B。[原始连续会话](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-18/runs/01/evidence/normal.json)

我另外在第二轮尝试取页面时主动制造一次捕获失败。整个 Driver 只发出一次模型请求。此时第一轮的工具已经失效，首次重排已经生效。停止这段会话后，另取一份页面能读到 B。结合两份上下文的手动预览对照，可以分清 App 发布更新、Driver 释放上一轮和下一轮成功取得页面这三个时刻。仅手动预览更新时，仍持有的第一份上下文可以读 A。当前 Driver 则在上一轮结束时主动释放它。何时定义为产品上的“采用新观察”仍待裁决。[捕获失败对照](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-18/owner-review/capture-failure.json) · [手动预览对照](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-18/owner-review/preview-order.json)

| 受控传输场景 | 模型请求 | Worker 读取 | 已成功的重排 | 已释放的上下文 |
| --- | ---: | --- | ---: | ---: |
| 完成两轮 | 2 | A、B 各一次 | 1 | 2 |
| 第一轮返回任何动作前报错 | 1 | 0 次 | 0 | 1 |
| 第二轮返回任何动作前报错 | 2 | A 一次 | 1 | 2 |

**送审报告第 2 节有一处文字更正。** 两份 HTTP 请求各自带本轮页面和工具参数说明。逐字相同的读取参数 `{"value":"Plan:unfinished_plans[0]"}` 出现在两轮模型的 **SSE 响应** 中。我逐条对照了响应、Driver 转发的输入、观察与页面绑定、执行权限、业务实收及发出的收据，原始记录和测试归属正确。首次封存的报告原样保留，本复核记录该处更正。[参数与收据核查脚本](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-18/owner-review/check-wire.py)

## 上一轮的数据还在哪里

正常结束和第二轮报错时，Driver 与 Source 都已释放上下文。Scope、观察、在途工作和快照借用数均为零。此时 Runtime 仍能按第一轮的快照 ID 查到完整的 A。一份历史快照占用 **14,352 个逻辑字节**，这是整个试件快照的大小。App 的当前列表仍包含 A，而且新一轮的第一项 B 持续可读。Runtime 关闭后，历史和当前快照、借用、Worker 与待办任务均为零。[分层计数](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-18/runs/01/evidence/verification.json)

我把这两份真实 Worker 数据原样输入公开 Core，用其支持的测试时钟验证默认期限。无读者持有时，退休后第 599,999 毫秒查询仍能读到 A，第 600,000 毫秒再查询得到 `SNAPSHOT_EXPIRED`，当前 B 继续可读。若另一个合法读者跨过期限仍持有旧快照，旧 A 仍可读。最后一位读者释放后再次查询，旧 A 才失效。这是主动查询触发的清理。这里验证的是 Runtime 持有的数据和调用资格，未测进程实际内存或 JavaScript 垃圾回收。[独立时钟对照](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-18/owner-review/history-window.json)

## 范围与下一步

正式交付后，我在新目录复跑全部 15 步，并核对 304 份构建输入、143 份 SDK/Runtime 声明、32 份本批交付原件和 9,971 个开工既有路径。交付清单 SHA-256 为 `2b2dd88453ab40c547e788b6dbc96eccbab1b161ae7f109d916f9146892fe5a4`。本批使用本地受控模型响应，失败场景为动作返回前的 HTTP 400。在线模型、其他传输故障、完整 Host/IM 的历史恢复和最终组合包仍需各自的验证。本批没有新增 App 作者步骤或改变生产规则。[签收清单](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/review-evidence/minimal-core-batch-18/final-delivery.json)

**Batch 19 只查清谁需要完整旧数据。** 给执行 Codex 的任务是分别验证仍持有旧页面的读者怎样取数据，只知道历史快照 ID 的调用方能否查询，以及已完成工具的收据能否独立回读。准出要能说明，若最后一个合法读者释放后立即清掉旧 Ref，谁会受到影响、谁仍能取得原收据，以及哪些行为需要所有者裁决。当前快照保留策略和公开 API 的变更留待这份影响评估。[Batch 19 范围、四项准出与 Codex Prompt](/Users/zhangwei/JSWorkSpace/learning_code/AgentOrientedTUI/MINIMAL_CORE_BATCH_19_TASK.zh-CN.md)
