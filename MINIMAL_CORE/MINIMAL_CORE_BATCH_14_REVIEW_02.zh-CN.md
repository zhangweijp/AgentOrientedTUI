# Batch 14 修订版独立复核

**APPROVED。批准范围是 Revision 1 的隔离试件。** 作者在一个工具的参数声明里写明需要哪种数据及其形状，例如一份计划或一份计划列表。SDK 保存声明，另一进程的 Runtime 可以只读 JSON 就辨认二者、检查输入。普通备注即使恰好等于引用名字，也按原字符串交给业务。[修订报告](review-evidence/minimal-core-batch-14/revision-1/REPORT.zh-CN.md) · [批准的累计补丁](review-evidence/minimal-core-batch-14/revision-1/MINIMAL_CORE_BATCH_14.patch)

首版收到 **CHANGES_REQUESTED**。它会把字段相同的用户和订单认成同一合同，还有一种普通字符串写法能通过严格类型检查，校验后实际拿到的却是对象。修订版把业务种类纳入合同身份，并在 SDK 的作者入口拒绝那种丢失类型信息的声明。两个相同种类的等价声明，即使书写顺序不同，仍得到相同身份。独立 JSON 读入会拒绝允许空引用名的声明，缺少长度约束的普通字符串数组也恢复原先的处理成本。首版复核已被修订清单按原路径记下指纹，单独保留。[首版复核](MINIMAL_CORE_BATCH_14_REVIEW.zh-CN.md) · [独立作者和消费者探针](review-evidence/minimal-core-batch-14/owner-review/revision-1/author-and-consumer.json) · [空名和遍历对照](review-evidence/minimal-core-batch-14/owner-review/revision-1/raw-and-ordinary.json)

| 独立检查 | 实际结果 |
| --- | --- |
| 在新目录分别构建原包、首版和修订版 | 37 个步骤符合预期。其中一组五项严格类型反例按预期编译失败。三个版本分别通过原有 Core 224 项和 SDK 17 项。 |
| 用真实发布记录里的计划、整份列表及元素校验 | 原有 13 条用例中，四条合法值通过，九条假对象、错误结构或超限数据被拒绝。我把校验后的值直接交给已通过严格编译的两个样例业务函数，分别读到 `plan_a` 和 `[plan_a, plan_b]`。 |
| 用跨进程 JSON 检验身份和执行边界 | 同形用户与订单拥有不同身份，单对象与列表也可区分。原包、首版和修订版的既有普通注册入口遇到最终声明都在创建执行器前拒绝，业务进入零次。 |
| 复核实际补丁、声明和保护范围 | 累计三个隔离文件，相对首版修改两个。源码和样例补丁均可反向还原。核对 178 件封存交付、9,213 个开工文件及 294 份冻结构建输入。原包到修订版有一处 Core 临时声明差异。 |

累计补丁 SHA-256 为 `67a26f369c5c02a49f564cd42036fe4d897034daeb0fa784d0489e693dd35d70`，正式交付清单为 `371c049f2a51f024fb294a989c320e523b70aa2c088407a88b95cf2188c0c64b`。[负责人签收记录](review-evidence/minimal-core-batch-14/owner-review/revision-1/final-verification.json)

**作者负担与剩余风险。** 每个工具手写一份参数声明，复用业务 Schema，模型参数和业务类型从同处推导。修订多写一个明确的业务种类，省去了靠字段形状猜测身份。应用层继续负责业务规则。真实 Planning 样本的发布类型是 `unknown`，本次直接调用业务函数只证明它能读到校验过的数据。实际调用仍要由 Runtime 和 Worker 证明名字来自哪次观察、是否授予该工具；线上整份列表执行、公开 API、包发布及最终 Semantic 验收均留在后续阶段。

**下一批为 Batch 15。** 用一个工具一次覆盖单对象、整份列表、逐项指定多个名字、可选引用和普通备注。准出要从导出的 JSON 区分各形状，任意一项传错时拒绝整组，并证明展开后的数据仍遵守原有总量限制。继续使用隔离副本，实际代码范围、准出和执行 Codex Prompt 见任务书。[Batch 15 任务书](MINIMAL_CORE_BATCH_15_TASK.zh-CN.md)
