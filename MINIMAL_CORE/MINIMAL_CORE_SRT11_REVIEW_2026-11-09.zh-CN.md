# SRT-11 完整交付独立验收

2026-11-09。**APPROVED，批准精确两文件候选采用。** 本次由 Minimal Core 负责人在执行方完整交付后一次审查；签署时共享源码仍为 before，由 SRT Owner 后续采用。没有发布或扩大性能改造范围。

依据是[完整任务](../SRT/SRT-11_MEASURE_REUSE_CLEAN_TASK_2026-11-09.zh-CN.md)、[执行报告](../review-evidence/srt-11-measure-reuse-20261109/REPORT.zh-CN.md)及实际源码。候选为 `.tmp/srt-11-measure-reuse-20261109/candidate`；[补丁](../review-evidence/srt-11-measure-reuse-20261109/srt-11.patch) SHA-256 为 `9bf57b6d67e278ba59f1c592f188907d1488a74b8d21803e7ec031914c12e3fd`。逐路径身份见[独立核对](../review-evidence/srt-11-minimal-core-review-20261109/identity.json)。

生产变化仅为 `runtime/src/core/invocation/scoped-interaction.ts` 删除授权返回后紧邻的第二次 `recheck()`。两次检查之间只有严格布尔判断，没有 await 或业务执行。保留的第一处仍在授权真正结算后检查观察资格、Ref 参数、当前 binding 与 live 状态，然后才允许进入业务；拒绝和清理顺序不变。可信 resolver/live 回调仍会运行，未将其改成缓存。`scoped-interaction.test.ts` 新增普通/Ref 两种模式各四项行为场景，覆盖授权允许、拒绝、等待时重新绑定、等待时采用新观察。

这次删除的是同一同步边界内重复承担的资格复核；必要行为继续由现有 ScopedInteraction、Observation、Snapshot Store 和绑定模块负责。没有新增抽象、缓存、协议、依赖或 App 责任。作者接口和认知负担不变，内核少维护一次无用重复调用。

独立验证如下：

- 核对共享两路径仍匹配 before，候选与交付 after 一致；生产差异精确等于上述一行删除，`git apply --check` 通过。没有把 HEAD 当作完整工作树基线。
- 阅读完整调用边界、fixture、原有关闭测试与新增测试；候选编译产物也保留授权后一次复核。
- 在精确候选独立执行三个相关测试文件，**236/236 通过、0 跳过**：ScopedInteraction 183、关闭 37、真实双 Producer 16。新增八项包含在内，已有异常时钟关闭/释放检查也随相关套件通过。命令及输出见[独立命令](../review-evidence/srt-11-minimal-core-review-20261109/test-command.json)、[测试结果](../review-evidence/srt-11-minimal-core-review-20261109/tests.json)。
- 审查测量脚本与私有 fixture，从原始 inspector 结果重新汇总两版各 20 个阶段：12 组调用比较均少一次 recheck、一次参数准备、一次 profile 编译及 11 次 copyJson；Worker 计数及无变化观察计数一致。核对六份无 coverage 的计时原始结果，每版 960 次正式重复操作、四 actor 每轮释放为零。见[测量审计](../review-evidence/srt-11-minimal-core-review-20261109/measurement-audit.json)。这些计时由执行方运行，负责人没有重复整套性能采样。

未发现阻断项。构建与前后测量复用执行方有效证据；未重复 Runtime 默认全量、包安装矩阵、GUI、Planning 人工流程或 TS/LSP 专项。原始测量接线失败及误用 fixture 的回归失败均保留，最终正式 fixture 的回归已由负责人再次验证。

收益边界明确：只批准有证据的局部减法。计时包括现有测试 actor/断言开销、固定顺序与有限正文规模，更新 fixture 仍回显 q；部分 p95 上浮，不支持“Runtime 普遍明显提速”的结论。没有证明大型工具目录、并发、RSS、真实模型或完整 IDE 的性能；不由本批关闭这些未来事项，也不新增缓存/dirty 协议来追逐无变化观察成本。

下一步由 SRT Owner 核对这两个目标尚等于 before 后采用，并刷新根 Runtime 构建与唯一索引；若目标发生并行变化，先保留事实并协调，不覆盖。可直接执行的交接 Prompt：

> 采用本报告批准的 SRT-11 两文件补丁，使用 changes.json 的 before/after 核对当前目标并保留原件。刷新根 Runtime 构建，记录实际采用身份并更新 deepseek_review.md。复用本次完整独立验收，不再重复行为矩阵；不改 SDK/API/协议/依赖或开启第二轮性能优化。

开发侧下一项沿用已在执行的[Host 预览完整任务](MINIMAL_CORE_HOST_PREVIEW_DELIVERY_TASK_2026-11-09.zh-CN.md)，由指定执行 agent 连续完成后统一交审。准出仍是已提交页面正确更新、乱序与 Topic/实例隔离、订阅及在途读取清理、Agent Observation 不受影响，以及必要的 Host 测试与构建，不拆成分片审批。
