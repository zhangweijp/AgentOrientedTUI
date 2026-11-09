# Batch 12 · Planning 引用合同独立复核

**最终结论：APPROVED（Revision 1）。** 批准范围是 Planning 的可复跑作者样例：哪些引用今天能执行、候选类型可以保留哪些业务约束。未批准新的公共 API、协议、生产实现或发布。[修订报告](review-evidence/minimal-core-batch-12/revision-1/REPORT.zh-CN.md) SHA-256 `f273e67f4da221fe5553fa5dcb3b39a2dd830086b9c8f0e20a5332d2abcc887b`，封存清单 `96d22e134594e5c430bbcb72d986d23d12a37c63d6125d36e92a3b5b3a69bb1a`。我逐项核对了清单中的 60 件原件、14 个样例文件、开工时已有的 8,704 个文件，以及两条工作线的 292 / 294 份输入。[负责人签收记录](review-evidence/minimal-core-batch-12/owner-review/revision-1/final-verification.json)

**首版 CHANGES_REQUESTED。** 运行结论通过；候选类型的证据不能证明报告所称的完整只读 Planning `Plan`。首版[报告](MINIMAL_CORE_BATCH_12_REPORT.zh-CN.md) SHA-256 `c21d84c3f9a976e6ef52bb79a738b0a3da9dd5dda5f6aeb9978221a75ee6e38d`，[交付清单](review-evidence/minimal-core-batch-12/final-delivery.json) `501c56f4aae3b22b874e7e2da4dfcf5bb56913f9ab81fd2f0d97d70b1cd48d44`。本批交付是隔离作者样例，没有共享生产补丁。

**修订样例的独立证据。** `99721030fe7891105157a22d46d6afe6784cc7c32aabf64a28cfec7818613e69` 的作者增量把任意字符串改成可推导字面值的 TypeBox 枚举。原有的“业务函数能接收吗”之外，我还用同一份[外部类型用例](review-evidence/minimal-core-batch-12/owner-review/domain-contract.ts)核对了计划对象、列表、阶段状态、任务状态和格式两端的类型。首版五处都失败；该修订五处全通过。原四项反例及非法阶段、非法任务状态、非法格式共七项均按预期拒绝。两个实际 SDK 都能导出这份普通字符串枚举，仍都拒绝 Ref 注解。重新构建并执行修订复跑脚本的 15 步，现行 Worker 的完整收据与业务值和首版一致。[独立增量与类型复跑](review-evidence/minimal-core-batch-12/owner-review/revision-1/independent-replay.json) · [全新构建与 15 步复跑](review-evidence/minimal-core-batch-12/owner-review/revision-1/fresh-replay.json)

| 同一个只读工具，传什么给它 | 我的独立观察 |
| --- | --- |
| 当前计划的名字 `active_plan` | 业务进入一次。工具拿到当次快照中的完整、递归冻结的计划；它与授权时检查的值一致。 |
| 第一项的名字 `Plan:unfinished_plans[0]` | 业务进入一次，收到该项计划。名字的 `Plan:` 是标识的一部分，实际类型标签仍为 `unknown`。 |
| 整份列表的名字 `Plan[]:unfinished_plans` | 页面已经发布列表，本样例宿主也把它授予该次观察；Core 在执行授权前以 `REF_VALUE_UNSUPPORTED` 拒绝，业务零进入。原页面正文没有整份列表的链接。 |
| **没有**选中计划时传 `active_plan` | 我另跑了同一个真实页面，仅令 `activePlan=null`。正文显示 “No active plan.”。在相同的授予策略下，旧工具仍收到 `{title:'No Active Plan'}`，并返回成功收据，计划 ID 为 `unknown`。这是现有 App 的占位数据；有标题不能证明有一份计划。 |

两个正常调用使用各自名字在**同一份原始快照**中的值；关闭后保留的 Scope、字节和 Worker 数量均为零。核对了新构建的 SDK/Runtime 的真实解析位置，两个版本的普通 Tool 都在**定义时**拒绝现有 Ref 注解：`TOOL_SCHEMA_UNSUPPORTED`，位置为 `$.properties.plan["x-aotui-ref"]`。[运行与拒绝原件](review-evidence/minimal-core-batch-12/owner-review/first-review.json) · [空选择的完整调用](review-evidence/minimal-core-batch-12/owner-review/empty-selection-worker.json)

**首版退回原因。** 在私有目录重新构建主线 SDK 0.3.0、锁定的 SRT SDK 0.4.0-srt01-m4.2 及各自 Runtime 3.0.0，独立重跑 13 步。原严格正例和故意写错的四项候选反例结果一致。但我把 handler 的 `phase.status` 传给真正的 Planning `TaskStatus`，编译器报它只是任意字符串；把 `format` 传给 `'summary' | 'phases'` 也一样。相同样本同时符合两套类型不能证明两套类型相同。要求在**样例**修正类型或收窄承诺，不触碰共享 SDK。[额外探针及诊断](review-evidence/minimal-core-batch-12/owner-review/owner-probes.json) · [真实业务类型](demo-apps/planning-app/src/types.ts)

**来源与范围。** 逐项比对首版的 135 项交付、8,704 个开工既有文件、主树 292 项/SRT 294 项源码及构建输入，复核时内容均匹配。共享主树 HEAD 及 Git 暂存条目指纹（`git ls-files --stage -z`）与开工相同。SRT 在这期间从 `dde087da` 新增 M4 提交 `f08403b0`，其 294 份选定输入仍逐字节等于封存版本。不凭这个提交替 SRT 签收。[指纹与两棵树](review-evidence/minimal-core-batch-12/owner-review/inputs.json)

**对作者的意义与后续。** 本批没有删生产实现，也没有让 App 承担解析职责。现行工具仍用另一套写法；统一候选只说明作者可以少写一份业务参数类型，尚不提供可运行的新 API。类型试件中的 `RefValue` 没有实现，不能验证任何运行时对象。本批没有跑完整 Host/Driver、线上模型、多/可选 Ref 或跨页面归属，也没有改变观察失效规则。后续先用真实宿主请求对照“页面说没有，实际却给出对象”的情况，准备仅在 Planning 两个页面副本消除占位的候选；使用同一套运行时接线验证后再考虑落地。[下一批范围、准出和 Codex Prompt](MINIMAL_CORE_BATCH_13_TASK.zh-CN.md)

**整个 Minimal Core 的位置（11 月 5 日晚）。** 第一轮内核去重已完成；[Batch 09](MINIMAL_CORE_BATCH_09_REVIEW.zh-CN.md) 已统一五个 Host 来源并删掉 Driver 的旧路由；[Batch 10](review-evidence/minimal-core-batch-10/owner-review/shared-application/final-application.json) 已按所有者决定落地并复验，单个订阅回调出错不会改写工具结果。[Batch 11](MINIMAL_CORE_BATCH_11_REVIEW.zh-CN.md) 实证了两处输入检查不能直接删。SDK 普通 Tool 的 SRT-01 M4 有独立工作树候选，未据此认定共享树已迁移或签收。后续主体是把 Ref/ArrayRef 真正接到同一套普通 Tool 上，迁移真实 App，再用同一组包跑 Host、IDE 和 Agent 作者任务，交所有者验收。D3 历史消息迁移已取消。旧进度表的 30–55 小时是修订前估算，不是当前承诺。
