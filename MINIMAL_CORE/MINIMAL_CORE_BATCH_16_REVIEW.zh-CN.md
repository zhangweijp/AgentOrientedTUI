# Batch 16 独立复核

**APPROVED。批准范围为六个文件的隔离补丁。** Planning 已在列表上写出 `itemType: 'Plan'`。原实现保留了名字里的“Plan”，生成快照时却一律填“未知”。候选让 SDK 把已有标注交给原注册入口，Runtime 把它与数据放在同一条记录，快照从这条记录取值。作者无需再声明一次。现有工具继续分别检查本轮能否读、类型是否相符、值能否作为单个对象使用。[批准的补丁](MINIMAL_CORE_BATCH_16.patch) · [发布端源码](review-evidence/minimal-core-batch-16/candidate/sdk/src/hooks/useArrayRef.ts) · [快照生成源码](review-evidence/minimal-core-batch-16/candidate/runtime/src/worker-runtime/dom-snapshot-producer.ts)

## 从 Agent 使用的入口读取

我用重新构建的 SDK 和 Runtime 装载真实 Planning 列表页，在默认 Source 返回的同一份上下文里看名字并调用工具，直接核对 Worker 业务函数收到的数据。不限类型的工具在两版都能读到计划。不同之处如下。[基线记录](review-evidence/minimal-core-batch-16/owner-review/default-baseline.json) · [候选记录](review-evidence/minimal-core-batch-16/owner-review/default-candidate.json)

| 同一个页面上的调用 | 候选结果 |
| --- | --- |
| 要求一份计划，传入列表第一个计划的名字 | 成功一次，业务拿到冻结的完整 `plan_a`。此前同一请求被拒绝。 |
| 要求计划，传入内容完全相同的订单，或仅把名字起成 Plan 的未标注条目 | 两者均收到 `REF_TYPE_MISMATCH`，业务零进入。用不限类型的工具可以读到它们。 |
| 要求一个计划，传入整份计划列表 | 收到 `REF_VALUE_UNSUPPORTED`，业务零进入。列表标注的业务种类是 Plan，实际值仍是一份列表。 |
| 从计划列表页读取另一页显示的计划名 | 尽管默认上下文同时展示两页，旧工具按其所绑定的页面查找，返回 `REF_NOT_VISIBLE`。显式释放上下文后再使用其中的旧工具，得到 `SEMANTIC_CONTEXT_RELEASED`。 |

## 补测列表长出新元素

执行者的五阶段测试覆盖了更新、缩短、变空与卸载。我另让真实 Planning 页面从空列表增长到两个计划。第二个名字在新上下文中标为 Plan，工具读到正确的 `plan_b`；再缩短列表，这个名字被拒绝。另一组控制数据在同一页面从 Plan 切成 Order，再切回 Plan。旧名字从新观察退出，工具只接受本轮类型相符的条目。两项注册调用都经过真实 Worker。关闭后，保留的 Scope、字节、Worker 和待办任务均为零。[独立增长与类型切换记录](review-evidence/minimal-core-batch-16/owner-review/growth.json) · [复跑脚本](review-evidence/minimal-core-batch-16/owner-review/probe-growth.py)

## 准出与保留的决定

- 我从冻结原包重新构建原版、签收 B15 基线及本批候选，完成 35 步。基线上要求 Plan 的断言按预期失败，另外 34 步成功。三个版本各通过已有 SDK 8 项、Runtime 125 项定向测试。在每个版本的 23 次定向引用调用中，逐项核对了观察、绑定、收据，成功时再核对授权看到的来源和完整值与业务实收一致。[独立核对记录](review-evidence/minimal-core-batch-16/owner-review/final-verification.json)
- 单独补丁的 SHA-256 为 `63ac303ab8dd1458b5fe802c0fd70c09190778669cf9fe7dde2e2e4776713e21`，交付清单为 `8c63add9489f8fc45622e3ffe9bdb37cca2530539dff6bfb574df665d2d7c550`。以 B15 实际输入正反应用并还原。复核了 149 份本批物理新增文件，其中 `run.py` 是 B15 命令运行器的副本；9,731 个既有路径、负责人四份开工原件和 SRT 的 294 份冻结源码均匹配指纹。[交付清单](review-evidence/minimal-core-batch-16/final-delivery.json)
- 核对全部 143 对重建声明，五份有差异。作者现有的数组 Hook 签名适用。框架的两个注册方法多了可选的类型参数，其余差异是内部返回记录及 Hook 文档。正式接口、混用不同版本和普通工具的多引用执行仍待验证与裁决。建议列表与元素共用作者写出的业务种类，由值形状区分“一个”和“一组”；另一种设计需要给列表另定类型身份。两者的正式选择归项目所有者。[实际声明差异](review-evidence/minimal-core-batch-16/declaration-changes.patch)

**下一批为 Batch 17。** 两页同时出现同一个名字、却代表两份不同数据时，共享工具怎样避免读错？给执行 Codex 的任务是用实际默认入口查明当前行为，核对真实 App 是否使用这种命名，再交“同一 App 内名字唯一”和“调用必须带确定的页面身份”两种方案对作者的影响。生产代码只读，后续命名合同由上级决定。[Batch 17 范围、准出与 Codex Prompt](MINIMAL_CORE_BATCH_17_TASK.zh-CN.md)
