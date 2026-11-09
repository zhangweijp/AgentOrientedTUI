# Batch 24 独立复核：采用依赖与能力边界

**APPROVED，仅签收只读盘点。** 不批准共享采用、不批准删除旧入口，也不把已有样机扩大为完整 Ref/ArrayRef 能力。[执行报告](MINIMAL_CORE_BATCH_24_REPORT.zh-CN.md) · [独立核验](../review-evidence/minimal-core-batch-24/owner-review/final-verification.json)

负责人从封存的实际共享源码和精确 SRT Git，在新目录 `/private/tmp/aotui-b24-owner-ambtyw72` 独立重建全部历史阶段。8 次签收补丁检查/应用通过；5 次针对共享副本的应用检查按预期拒绝，原始 stderr 保留。292 路径矩阵、各阶段指纹和统计与交付逐项一致。600 件共享输入、460 件构建指纹及 HEAD/index 没有改变。[独立对照归档](../review-evidence/minimal-core-batch-24/owner-review/independent-comparison.tar.gz)

实际共享 SDK 与候选的作者接口不同。共享 Core 还包含配置读取边界、终态规则、响应单捕获、注册字段去镜像和 WorkerError 诊断等独有变化；B09/B10 执行链与 B23 新说明也必须保留。因此 B22 的隔离签收不构成“把候选整个目录覆盖共享”的依据。

负责人从封存的共享 Core JS 和实际 B22 tar 独立复跑 32 组纯编译探针及 getter 对照：共享配置拒绝前读取 getter 0 次，候选固定基线读取 1 次并透出探针异常。该差异已作为正式采用风险升级，不能归咎为 B22 相对其原基线新引入的回归，也不能在当前只读任务里擅自修复。[独立纯 Core 结果](../review-evidence/minimal-core-batch-24/owner-review/core-capabilities.json)

能力边界准确：试件编译器能描述数组、多个与可选 Ref；B22 的实际执行 profile 只接通一个必填对象 Ref，数组中的一个元素也属于这个情形。类型编译、已发布名字和真实 Worker 业务进入分别记账，没有据此签收数组整体或 SRT-05 自动撤销旧观察。旧入口还有公开消费者和契约测试，本批没有删除。

复核纠正了一处理由表述：业务 ID 查找不是应被消除的重复框架职责。Ref 是参数语义的选择；App 仍须根据收到的 Plan 的业务 ID 检查当前能否打开。原报告与清单保留在 `submitted-original/`，技术证据没有重跑或改写。最终报告 SHA 为 `533dd43f20da8f34a5ae1be7a5ddcf67e7b2dc830d2ba770f10b4ba9483f710f`；最终清单 SHA 为 `4e6c7a91ad273397627be983404f2233feea0eeaeabe088759c497370ed811a8`。

未覆盖：完整集成冲突解决、全能力 Worker 链路、真实模型使用、GUI 手测及正式包/共享 API 采用。历史成绩只按精确签收引用，没有记为本批新测试。

**下一步 Batch 25 已下发并执行。** 因所有者正在请求实际 Host 验收，优先在独立数据和 profile 的现有 Host 中接入真实 Planning 的一个必填 Plan Ref 工具。核心原包不改，当前 Host 不停止，用户配置、聊天和业务数据不覆盖。准出为可启动命令、真实 Worker/Source 正反例、收据/View 分离、实际 GUI 可用和数据隔离实证，再由两位负责人分别独立复核。它不绕过上述正式采用风险。[范围、准出和 Codex Prompt](MINIMAL_CORE_BATCH_25_TASK.zh-CN.md)
