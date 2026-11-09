# Batch 13 独立复核

**最终结论为 APPROVED，仅限 Revision 1 的两页隔离补丁。** Planning 现在只在确有当前计划或阶段时给工具一个可用名字。两个页面仍显示计划和阶段的业务 ID。首页与详情各删除一处只有标题的占位对象，各用一个页面内的小组件调用现有 `useDataRef`。Planning 决定对象是否存在，SDK 随组件挂载和清理引用，Runtime 检查调用权限并交付数据。作者沿用现有接口。[修订报告](review-evidence/minimal-core-batch-13/revision-1/REPORT.zh-CN.md) · [已批准的两页补丁](review-evidence/minimal-core-batch-13/revision-1/MINIMAL_CORE_BATCH_13.patch)

我将正式累计补丁应用到原版页面的私有副本，核对两页的字节与独立测试的版本相同，并验证可以逐字节还原。原有四个测试文件原样运行，原版 13/13、首版 12/13、修订版 13/13。从封存输入重建的 23 个步骤也符合预期，包括原版错误放行和首版丢失阶段 ID 断言这两个预期失败。修订包的 81 份原件已逐项核对。累计补丁 SHA-256 为 `b3e5327fe5b7ddcb9be93764f85fd2f677bdb73b99672f939ee1b57df63b4954)，修订交付清单为 `8e48045acf5e67d802e4b60d44b31eb1e61062e62898a860376abe7264b4501a)。[负责人签收记录](review-evidence/minimal-core-batch-13/owner-review/revision-1/final-verification.json)

修订版在真实 Driver 的六次串行调用中，四次针对不存在对象的尝试均在进入业务前被拒绝，两个真实对象各成功读取一次。我对照了模型请求、同轮授权和执行收据。有对象时两个名字在页面末尾的可用引用列表中都可能排得靠后，按名字调用成功。实际 Planning App 用页面给出的 ID 完成两个阶段，全部完成时仍能引用打开的计划，关闭计划后详情页退出。另外验证了计划和阶段仍在、内容已经更新的情况，同名引用交付了新标题与嵌套任务。这些运行均通过本地真实 Worker；模型响应由测试控制，旧观察的替换规则另行验收。[真实 Driver 记录](review-evidence/minimal-core-batch-13/owner-review/revision-1/candidate-trace.json) · [实际 App 流程](review-evidence/minimal-core-batch-13/owner-review/revision-1/actual-planning.json) · [内容更新](review-evidence/minimal-core-batch-13/owner-review/revision-1/update-trace.json)

**下一批为 Batch 14。** 用隔离样例把“这个工具需要一份计划或一份计划列表”写一次，让模型传名字，程序能在另一进程从声明辨认形状、检验取到的值。准出要证明真实对象和列表能通过，假对象、形状错配、非法嵌套或超限会被拒绝，旧执行入口遇到新格式会安全拒绝。公共接口与正式接入留给上级裁决。具体范围、准出和给执行 Codex 的 Prompt 已写入任务书。[Batch 14 任务书](MINIMAL_CORE_BATCH_14_TASK.zh-CN.md)

## 首版复核记录

**首版结论为 CHANGES_REQUESTED。** 首版补丁的 SHA-256 为 `860e59ba2b3e362eb90ad4f4908119019216c9721b1356893e6860ddc88053dd`。两个空对象都已从模型的新观察中退出。Planning 自带的一项回归测试在该补丁上失败，执行者需要修正页面并补全两页引用顺序的对照。[首版补丁](MINIMAL_CORE_BATCH_13.patch) · [复核原件](review-evidence/minimal-core-batch-13/owner-review/first-verification.json)

我从封存的 302 份输入重新构建 Driver、Runtime 和 SDK，在私有副本正向应用并反向还原补丁。通过受控模型响应让真实 Driver 发出六次调用，核对了模型请求、同轮观察、工具收据和业务函数收到的值。

| 新取得的上下文 | 首版候选的实际结果 |
| --- | --- |
| 没有当前计划或阶段，以及对象退出后 | 两个名字从各自页面的可用引用里消失。四次强制调用均返回 `REF_NOT_VISIBLE`，业务进入零次。 |
| 有计划和当前阶段 | 两次调用各进入业务一次，收到同一轮观察中的完整只读对象。页面正文和模型工具定义匹配基线。 |
| 未完成计划列表 | 空列表仍可见。有元素时传入该元素的名字能读到计划，传整份列表按现行规则返回 `REF_VALUE_UNSUPPORTED`。 |

**退回依据。** 我复制了完整 Planning 包及其四个原有测试文件，分别在基线与首版上运行 `pnpm run test:run`。基线 13/13 通过，首版 12/13 通过。详情页测试会遍历页面直接返回的 JSX 子节点。取走 `current_phase` 占位数据时，首版也把阶段 ID 的显示移入子组件，原测试因而读不到 `Phase ID: phase-current-4`。真实模型消息仍有该 ID。我要求在已授权的两个页面副本内修好并保留原断言。[实际回归](review-evidence/minimal-core-batch-13/owner-review/planning-view-regression.json) · [完整 Planning 测试](review-evidence/minimal-core-batch-13/owner-review/planning-first-full-suite.json)

**模型还能看到两项排序变化。** 在同一条“出现对象”的路径，首页的 `active_plan` 从未完成列表之前移到其元素之后。详情的 `current_phase` 从当前计划之后移到几个列表名称之后。两个页面的引用名称集合和归属一致。首版比较器只提取了详情页的顺序，修订版应逐页报告。顺序变化已经保存在负责人独立提取的实际模型请求中。[顺序与收据对照](review-evidence/minimal-core-batch-13/owner-review/first-verification.json)

我另装载了实际 Planning 工厂，用该 App 的 SQLite 存储和公开工具创建含两个阶段的计划，按页面上的业务 ID 连续完成两个阶段，再关闭计划。第二阶段接替第一阶段时，详情页显示了第二个 ID。全部完成时，当前计划仍可用，未完成列表为空。在候选上，此时只有当前阶段的名字退出。关闭计划后，详情页退出，当前计划的名字也退出。两版的四项业务操作都成功，关闭后保留的 Scope、字节、Worker 和待办任务均为零。这条对照使用实际默认 Source，前面的六次 Driver 调用使用带只读观察工具的测试 App。[实际 App 对照](review-evidence/minimal-core-batch-13/owner-review/actual-planning-candidate.json) · [复跑脚本](review-evidence/minimal-core-batch-13/owner-review/actual-planning.mjs)

首版候选删掉两个只有标题的假对象。Planning 决定是否存在当前业务对象，既有 SDK 挂载和清理引用，Runtime 管理观察与执行。App 作者仍使用已有 Hook。此次复核覆盖串行调用和新观察，线上模型、旧观察的接替规则与 SRT 集成留在各自的验收范围。首版 88 项交付和 8,910 个开工已有文件均匹配原始指纹。
