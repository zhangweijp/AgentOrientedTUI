# Batch 15 独立复核

**Revision 1 为 APPROVED，批准范围是隔离副本的参数合同。** 一个 Planning 工具只写一份参数声明，就能要求一份计划、用一个名字取整份计划列表，或让模型逐个点名几个计划。可选参数和普通备注也由同一份声明处理。公开接口定稿、通过真实会话按名字取值并执行工具，仍各有准出条件。

首版结论为 **CHANGES_REQUESTED**。首版额外允许逐个提供多个**列表**名，业务函数会拿到两层列表。复核用相同字段分别检查必填和可选声明，在实际 SDK 和独立读取 JSON 的 Core 上都复现了这项越界。修订在原有 Core 数组项编译处增加两行，限制每个被点名的对象。SDK 与 JSON 接收端现在都能在声明时指出出错的数组项。一个名字取整份列表、计划内部的阶段和任务列表仍可使用。[首版复核与反例](review-evidence/minimal-core-batch-15/owner-review/first-verification.json) · [两行修订](review-evidence/minimal-core-batch-15/revision-1/FROM_FIRST_CANDIDATE.patch) · [修订后的独立探针](review-evidence/minimal-core-batch-15/owner-review/revision-1/selection-boundary.json)

| 复核内容 | 我实际得到的结果 |
| --- | --- |
| 同一个工具按名字取整份列表，再逐个点名 | 列表内容是 A、B。点名 B、A、B，业务也按 B、A、B 收到。顺序和重复项都保留。一条备注即使写成计划的名字，业务收到的仍是这段文字。 |
| 可选项缺省、填错，以及超出容量 | 三个可选项的八种有无组合逐一通过。另五组混合错误均整组拒绝。将同一个大对象在两个参数中各放一次，整体超限被拒绝；在同一个选择列表中重复它，还分别验证了字节数和节点数上限，两个拒绝样例都在进入业务前停止。 |
| 原有调用与类型 | 从四套重新构建的包复跑 73 步，四套各通过定向 Core 224 项、SDK 17 项。首版边界测试按预期失败，两组编译反例分别得到 8 项和 5 项诊断。原 53 条输入及结果逐项匹配，14 条通过、39 条拒绝，8 种合同身份可区分。默认注册入口拒绝新声明，执行器和业务函数进入均为零。 |
| 源码与交付 | 累计补丁只改一份 Core 源码。以实际 B14 输入验证“直接应用累计补丁”和“先首版再修订”得到相同内容，按相反顺序还原。294 份冻结输入及 24 份实际构建的声明均核对。复核清单中的 169 份新增文件、首版 209 份、修订开工时的 9,577 个文件均匹配指纹。 |

作者少了一项限制，即一个工具以前只能声明一个必填引用。字段分类、结构校验和容量检查都留在已有的 Core 参数编译器里，App 作者只给出业务类型和字段。一共十次直接调用经过严格类型检查的样例业务绑定，覆盖八种可选参数组合和两次容量正例。真实记录中的名字和数据用于这些测试；当前观察是否允许读取某个名字，要在实际接入时另行验证。[独立业务输入与容量结果](review-evidence/minimal-core-batch-15/owner-review/revision-1/usage.json) · [完整独立核对](review-evidence/minimal-core-batch-15/owner-review/revision-1/final-verification.json)

批准的累计补丁 SHA-256 为 `d26a4a55053478146aaf8b7e8b4e3b473b02f2df17e0ecdfad2df4a88b51c0e6`，交付清单为 `4f2d4001c2f1ca8aef2dae8b284f837eaf02be79fb0efd7cafdccda42e40b034`。共享工作树沿用原有工具入口。复跑命令为 `python3 review-evidence/minimal-core-batch-15/revision-1/reproduce.py`。[批准的补丁](review-evidence/minimal-core-batch-15/revision-1/MINIMAL_CORE_BATCH_15.patch) · [交付清单](review-evidence/minimal-core-batch-15/revision-1/final-delivery.json)

**Batch 16 只追踪发布方已经写出的计划类型。** 我用同一真实 Planning 页面和 Node Worker 做了两次对照。页面给列表元素标了 `Plan`，快照却记为 `unknown`。允许任意类型的只读工具能读到这个元素；要求 `Plan` 时，同一个已授予的名字在进入业务前收到 `REF_TYPE_MISMATCH`。给执行 Codex 的任务是在隔离副本沿原有注册入口把标注传到快照，验证计划元素成功、同形的其他类型和仅有名字前缀的元素被拒绝，并检查列表更新、缩短、变空和页面关闭。共享 API 和正式执行协议留待上级裁决。[真实 Worker 对照](review-evidence/minimal-core-batch-16/owner-review/opening/requires-plan.json) · [Batch 16 范围、四项准出与执行 Prompt](MINIMAL_CORE_BATCH_16_TASK.zh-CN.md)
