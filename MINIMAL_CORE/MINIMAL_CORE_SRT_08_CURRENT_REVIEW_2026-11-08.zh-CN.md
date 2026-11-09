# SRT-08 当前失败隔离核对

2026-11-08。**APPROVED：当前候选的单 App 失败隔离及本报告列明的行为核对。没有发现需要修复的具体缺口，不新增生产代码或测试机制。** 采用仓库 Minimalist 技能的复用原则，以实际源码和已有测试收口；共享采用、发布和最终 Semantic 验收仍分别处理。

核对基线为 `.tmp/srt-04-clean-20261108/candidate-r01`。其 `agent-driver-adapter` 全部 10 文件与已批准的 SRT-04 r02 相同。当前 Source 文件 SHA-256 为 `3ce431f331629a3a2e74a93329b13769079a01446f1b34b4580e5858d6109c14`。不能再根据旧共享树的描述认定这份候选缺少逐 App 隔离。

**现有实现已经承担必要职责。** `agent-driver-adapter/src/semantic-aotui-driven-source.ts` 的 `getContext()` 先为每个 App 局部准备页面、工具和绑定，成功后再合入 Context。声明、命名、绑定或观察失败进入对应 App 的诊断；失败准备释放 Observation，并在没有其他合法持有者时关闭 Scope。跨 App 工具别名冲突按确定顺序处理，未接受的 App 不输出部分页面或工具，其他 App 继续可用。已有 Context 仍持有的 Scope 不被无关的新投影失败误关。

**验证。** 执行 agent 原样运行现有 Source 测试与 `tests/agent-driver-adapter/real-core.integration.test.ts`，结果 **2 文件，42/42 通过**。负责人审查实际处理代码和断言后，在另一临时目录原样复跑，同样 **42/42**；没有添加测试、安装依赖或修改生产。测试输入与冻结候选一致，Runtime 辅助入口复用本次 SRT-04 已核对的正常安装包。[执行方结果](../review-evidence/minimal-core-srt08-check-20261108/vitest-result.json)、[独立执行记录](../review-evidence/minimal-core-srt08-owner-review-20261108/run.json)、[独立结果](../review-evidence/minimal-core-srt08-owner-review-20261108/test.log)。

真实 Registry / Receiver 组合用例同时验证：

- 一个 App 的公共工具名无效、另一个 App 发生别名冲突时，健康 App 仍能展示页面并实际执行工具，失败 App 不进入业务 handler。
- 失败 App 有明确诊断；失败准备的 scopes、observations、reservations 和逻辑字节归零。
- 修复声明后，下一次 Context 能重新展示并调用该 App。
- 释放 Context 后 active leases 归零；关闭后 Registry 的 View、binding 和保留字节归零。

Source 单测另覆盖坏 Schema、Scope 打开失败、恢复及旧 Context 的持有。这些并非只凭 mock 清理调用推断完整资源释放；真实组合用例检查了实际 Core 统计。

**边界。** 这是当前 adapter 与 Core 组合行为的源码测试核对，没有新增 Worker、GUI 或模型验收，也没有重新验证整个发布依赖图。SRT-05 将改变成功采用新观察后的资格交接，应在它的实际变更中保留失败准备、健康 App 可用性和资源清理保证；本报告不预先批准后续代码。

**下一片。** 不为 SRT-08 再安排开发。SRT Owner 已把 [SRT-05 串行观测交接](../SRT/SRT-05_CLEAN_TASK_2026-11-08.zh-CN.md)交 Clean 实现，Minimal Core 负责人复核实际交付。准出条件是成功采用 O2 后 O1 调用／Ref 资格失效、不误绑同名新对象、旧独占引用释放且共享数据存活，并保持失败准备与关闭语义。

> 复用现有 Core 观察与释放机制完成 SRT-05 的具体行为；有真实缺口再写最小正确差异，不增加跨轮常驻状态、管理器或假想回退。交实际 patch、相关测试和必要包身份，由负责人独立复核；已有 SRT-08 机制继续使用，不另造一套错误隔离。
