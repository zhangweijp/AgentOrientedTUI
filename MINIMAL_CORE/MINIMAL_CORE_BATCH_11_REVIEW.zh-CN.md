# Minimal Core Batch 11 独立复核

**APPROVED。** 批准的是 R4 普通工具参数校验的只读盘点。针对本次核查的两个位置，直接删除检查都会改变运行行为。共享生产、永久测试和公开 API 的本批改动均为零。执行报告 SHA-256 为 `3882487a7345cdf5efd99c1d253ac9c415f9f6fd4dc943b176500461a193cfb9`，交付清单为 `c3d20f56c197e9e603a014547482ecd0ea29600178387dfe806f3f7745c79181`。两份删除实验仅存在于各自的临时副本。[执行报告](MINIMAL_CORE_BATCH_11_REPORT.zh-CN.md) · [独立核验记录](review-evidence/minimal-core-batch-11/owner-review/final-verification.json)

## 为什么保留检查

| 路径 | 独立运行结果 |
| --- | --- |
| Core 收到普通调用，在授权前校验参数 | 参数要求数字，传入字符串，正常代码在授权前拒绝，业务进入 0 次。临时删掉该块后，同一输入进入业务 1 次。一个明确允许转换的 validator 则可以把 `{line:'7',surplus:true}` 转成 `{line:7,defaulted:true}`，授权与执行使用同一份冻结结果。删除后转换也消失。 |
| Worker 在接收进程校验参数 | 同一份坏请求直接发给真实 Node Worker，使用默认 SDK 时，删除 Worker 检查前后都拒绝，错误说明和诊断字段却不同。另用真正的注册表接入一个自行提供执行函数的工厂，绕开 SDK 的二次校验，错误枚举、多余字段、空枚举值的业务进入次数分别从 0 变成 1。这个计数探针在进程内运行，使用与真实 Worker 相同的编译入口。 |
| 注册表的公开低层直调 | 负责人另从外部消费目录按包名导入 `@aotui/runtime/core`。直接调用 `invokeTypeTool` 时，注册工厂自行校验会拒绝坏值。工厂未自行校验时业务会收到 `{line:'wrong'}`。两种工厂在注册撤销后均拒绝旧调用。给每个低层直调强制加上参数检查会改变该公开行为，需要单独裁决。 |

[Core 现行行为](review-evidence/minimal-core-batch-11/owner-review/baseline-core-trace.json) · [删除 Core 检查后的行为](review-evidence/minimal-core-batch-11/owner-review/mutant-core-trace.json) · [真实 Worker](review-evidence/minimal-core-batch-11/owner-review/baseline-worker-facts.json) · [低层直调对照](review-evidence/minimal-core-batch-11/owner-review/public-registry-trace.json)

## 复核范围与边界

我从共享工作树取出 301 份开工输入，另建基线、无 Core 检查、无 Worker 检查三个副本。新建的基线 Runtime/SDK 共 444 份构建文件，与执行者记录逐字节相同。Core 五个场景分别在现行版和实验版复跑，逐场景完整记录与执行者相符。真实 Worker 单独使用本轮新建产物，核对实际发送、收据和业务进入。测试还覆盖了授权等待期间撤销绑定，以及消息发出后、执行前发生的失效。

正常基线的独立 Vitest 检查合计 **146 项通过**，其中参数边界 128 项、SDK helper 9 项、真实 Worker 9 项。删除 Worker 检查时预期变红的三项另计。两套删除实验都在临时目录还原并重建。对 SRT 的核查仅限选取的源码，确认其 SDK 在参数校验后还会检查当前执行函数是否有效。本次未运行 SRT、整仓套件、GUI 或实网，也没有测量重编译成本。[输入与指纹](review-evidence/minimal-core-batch-11/owner-review/review-inputs.json) · [业务进入次数对照](review-evidence/minimal-core-batch-11/owner-review/registry-worker-mutant.json)

## 负责人决定与下一批

本批关闭这两条直接删除建议，保留 Core 的授权前校验、Worker 的接收端校验和 SDK 现行调用责任。已发现的每次 Worker 调用重新编译参数合同问题保留在 R4，后续若要迁移责任，应在选定版本上验证低层直调、完整错误和 SRT 校验后的执行资格。本批没有给 App 作者增加任何接线，也没有据此宣称作者接口已经变简单。

Planning 已能向 Agent 展示单个计划和计划列表。下一批用隔离样例对照现行公开写法与一种最小候选写法，弄清普通工具要如何接收这些计划引用，以及哪些公开接口差异需要上级决定。[Batch 12 范围、准出和 Codex Prompt](MINIMAL_CORE_BATCH_12_TASK.zh-CN.md)
