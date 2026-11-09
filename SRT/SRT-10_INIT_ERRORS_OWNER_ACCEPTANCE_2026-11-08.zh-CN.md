# SRT-10 INIT / OPEN 诊断：Owner 验收与根采用

2026-11-08。**APPROVED，已采用到实际根目录。** 本裁决关闭模块初始化和首次渲染失败时原始错误丢失的已知缺口；不表示 SRT-10 的通用结果模型、全局错误体系等未来设计已经实现。

## 实际结果

Worker 在清理前捕获有界的原始 name/message/stack，通过已有响应传给 Host。Host 使用本地请求的 appId / INIT 或 OPEN phase，将诊断放入非枚举 cause；AppManager 和 WorkerSandbox 的两层 INSTALL_FAILED 包装继续保留原因。OPEN 主错误不再被持久化失败摘要覆盖，保存中止、清理及资源释放事实仍独立报告。

Owner 已集中阅读全部生产差异、相关测试和执行日志，未发现阻断问题。B05 测试从错误的持久化归类改为断言 E_OPEN_FAILED、原始 duplicate-owner 消息与 usePersistentState 堆栈；不保存默认数据、unsafe 状态、ownerSlots 归零、dispose/release 和禁止 Worker 复用要求全部保留。原 INIT / OPEN 测试只增加非枚举和 JSON 边界断言，没有降低原始错误及清理要求。

开发诊断沿现有链路传递，没有新增错误类体系、调度器、兼容层或依赖，也没有修改 ToolResult、effects/unknown、重试、Ref/Scope/Observation 或应用业务职责。当前用法见 [初始化诊断说明](../runtime/docs/initialization-diagnostics.md)。

## 质量证据

| 检查 | 真实结果 |
|---|---|
| Clean 首次相关检查 | 8 个文件，94 项通过 |
| Clean 唯一一次 Runtime 默认全量 | 131 个文件，2080 通过、2 失败；原 INIT / OPEN 两项已通过，新发现本地 message 漏错误码和 B05 旧归类断言 |
| Clean 最终修正后相关检查 | 10 个文件，134 项通过；包含上述两处修正及原 INIT / OPEN、健康安装和资源清理 |
| Owner 根目录构建 | Runtime、SDK 均通过 |
| Owner 根目录关键真实 Worker 检查 | INIT、OPEN、健康安装与关闭、B05 初始绑定失败、旧作者协议拒绝，共 5 项通过；其余 38 项按名称过滤未执行 |

Owner 三条构建/验证命令合计 2.64 秒。最终候选未再次运行默认全量；上述组合证据不能写成“最终默认 2082/2082 实跑通过”。本轮没有重跑 GUI、真实模型、全仓、正常包消费、第三方 TS/LSP 或性能矩阵。

完整执行记录见 [Clean 报告](../.tmp/srt-10-init-errors-20261108/REPORT.zh-CN.md)；Owner 的 [检查命令及退出码](../review-evidence/srt-10-init-errors-owner-20261108/checks.json)、[原始关键检查日志](../review-evidence/srt-10-init-errors-owner-20261108/critical-real-worker.log) 均已保留。

## 精确采用与后续

采用 Clean 交付的 10 个 Runtime 路径（7 修改、3 新增）。四份交付文件哈希、目标路径 before/after 均已核对；7 份既有文件备份后逐路径采用，新文件此前不存在。没有覆盖其他并行工作。

HEAD 仍为 `8938449925ada2f92e072e1c0492af8f2428d14f`。交付记录的 index 字节哈希与 Owner 采用起点不同，但当前暂存差异为空、10 个目标路径全部匹配交付 before；采用起点的 index 哈希为 `f1c3915ab08d3cc2cfb7740ca1dd865b4910db626b633061a7a132e155520286`，采用前后保持不变。本次未写 Git index、提交、推送、合并或发布。身份与采用记录见 [preflight](../review-evidence/srt-10-init-errors-owner-20261108/preflight.json)、[adoption](../review-evidence/srt-10-init-errors-owner-20261108/adoption.json)。

**本批无未解决阻断。下一条执行指令：Minimal Core 作者交付任务继续整项完成 SDK 入口、示例、迁移与实际包消费闭环，按需链接本轮诊断专页，由 Minimal Core Owner 一次集中验收；SRT Owner 负责采用及唯一索引同步，不追加重复复核。** 通用错误模型和 SRT-11 性能工作未启动，第三方 TS 声明与原生 LSP 关闭问题保持独立状态。
