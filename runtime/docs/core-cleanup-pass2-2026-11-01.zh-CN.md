# SDK / Runtime 第二轮内核清理

## 范围与状态

本轮基线为 `6b1914b5a0752e3e1b135301f4cef5ffb4ffbc49`，延续项目所有者已经批准的 Breaking Change 和减法原则。第一轮的具体交付与验证留在 [第一轮记录](core-cleanup-2026-11-01.zh-CN.md)，不能把其中的旧计数或通过记录当成本轮验证。

本轮先只读追踪消费者与生命周期，再由三名 GPT-6 Luna Max worker 分工实施，主代理复核设计、差异与集成验证。下列 17 项清理已完成并通过验证。MEM-01 继续独立处理。

## 已审核的改动清单

| ID | 删除或收敛内容 | 依据与保留合同 | 实施负责人 |
| --- | --- | --- | --- |
| P2-S1 | SDK 不可达的 LLM Provider 分支和 `useLLMOutputHistory` | View/factory 没有提供者；保留 Host → Worker DOM 事件 → `useLLMOutputChannel` 的真实实时通道 | Luna SDK |
| P2-S2 | `useAppEnv` 单键包装 | 直接读取现有 `useAppRuntimeContext().launchConfig`；迁移 Terminal、持久化 Hook 和 Agent 开发指导 | Luna SDK |
| P2-S3 | `resolvePersistentAppName` 及其自测 | 没有生产调用；保留 Runtime 的真实持久化 namespace 和 hydration 行为 | Luna SDK |
| P2-S4 | SDK 重复的 OperationError/OperationResult 定义 | 直接复用 Runtime SPI 类型；保留 SDK 参数声明与 handler 推断 | Luna SDK |
| P2-C1 | Receiver 两个无消费者的转发方法 | 保留 Scope 内的来源捕获和 Ref 参数处理 | Luna Core |
| P2-C2 | Interaction 四个全局计数镜像 | 从 State/ledger 汇总；上限只能调低，Scope 硬上限 16；关闭中工作仍留在集合并占位 | Luna Core |
| P2-C3 | Observation 两个全局计数镜像 | 从 Scope Map 汇总；取消的 reservation 结算前继续占位，容量拒绝和释放不变 | Luna Core |
| P2-C4 | `semanticToolResult` 包级导出 | 映射保留为 Source 内部实现；测试迁到 `executeTool()`，保留成功、失败、部分副作用、accepted、unknown 区别 | Luna Core |
| P2-C5 | 实现模块 `export type *` | 内部类型直连定义模块；Core 正式具名类型出口保留，迁移 engine/SPI 导入 | Luna Core + Runtime |
| P2-R1 | Sandbox 无消费者的 Worker 状态/快照诊断转发 | 保留 WorkerHost 的实际发布诊断、健康变化与恢复证据 | Luna Runtime |
| P2-R2 | Sandbox fire-and-forget `dispose()` | 真实管理路径等待 `disposeAsync()` 报告，继续保留它 | Luna Runtime |
| P2-R3 | 无消费者的 Desktop `drain()` 包装 | 关闭入口统一到已有 `beginClose()`；等待和共享关闭操作的行为测试迁移 | Luna Runtime |
| P2-R4 | Desktop `getAppInfo()` → Manager `getAllWorkers()` 死访问链 | 迁移测试到现有受控查询，不增加替代 getter | Luna Runtime |
| P2-R5 | Sandbox `_disposed` 镜像 | `beginCleanup()` 同步建立 intent/closed；保留执行前后状态检查及关闭等待 | Luna Runtime |
| P2-R6 | 无消息消费者的 `promptRole` 配置链 | View 继续作为 User Message；同步删除类型、保存、透传、产物生成和字段传播自测 | Luna Runtime |
| P2-R7 | 无生产调用的显式 `WorkerPool.warmup()` 包装 | `acquireLease()` 首次自动预热仍保留；迁移一次预热和部分构造失败释放测试 | Luna Runtime |
| P2-R8 | 恒为空的 InstalledApp/AppState `html` 和无消费者的 `AppConfig` | 已退出 HTML 安装链的残留；`serialize()` 仍提供关闭时可读的应用状态与元数据，不再假装保存页面正文 | Luna Runtime |

计数推导减少的是必须同步维护的可变状态，不代表这两个文件行数必然减少，也不宣称性能提高。容量、来源身份、关闭结算、输入预算和错误语义不作为可选功能删除。

当前持久化与关闭指南中的 `legacy-unverified`、旧 SDK 回退和过时阶段说明也已同步清理。正式工厂与 INIT 必须满足当前协议；外部资源未确认时仍保留真实的 mixed/unverified 报告，不能把不确定性清理成成功。

## 行为测试迁移与验证要求

- 删除 Provider/history、孤立持久化 helper、promptRole 传播等仅证明退出接口的测试；不把这类数量下降报告成运行能力下降。
- 保留真实输出事件、卸载清理和回调更新；真实 Worker 输出链也要验证。
- 旧绑定拒绝与新绑定成功、容量耗尽拒绝与释放后可用、关闭等待与资源最终释放必须成对验证。
- 显式 warmup 的有效行为迁移到实际 `acquireLease()`；Desktop drain 的有效关闭行为迁移到实际关闭入口。
- R1–R5 已修复的实例身份、禁止嵌套 View、绑定重注册、IPC 前捕获及配置字段诊断继续回归。
- 用本轮重新构建、打包、安装的包验证消费路径，不能借用旧 dist 或工作区别名当作新包证据。

## 证据与交付边界

### 实际结果

| 检查 | 结果 |
| --- | --- |
| Runtime 全量 | 125 个文件，2097 项通过，0 skip / todo |
| SDK 全量 | 15 个文件，145 项通过，0 skip / todo |
| SDK 公开类型 | 通过；OperationResult/OperationError 与 Runtime SPI 同源，handler 推断保留 |
| 两包 noUnusedLocals / noUnusedParameters | 均通过 |
| 构建 | Driver、Runtime、SDK、IDE、Terminal、Lite Browser、Token Monitor、Planning、Host 共 9 项通过 |
| 新包安装与身份 | 8 个本地 tar，离线安装、禁用安装脚本；745 个包文件逐一与 tar 比较一致，AOTUI 包目录均非 symlink |
| 公共消费 | ES2022-only Core 示例运行/类型，Runtime/SPI/SDK/Source 严格类型；退出 API 的负向类型检查通过 |
| 真实 IDE | 打开、编辑、当前 View 替换、真实 LSP 与 managed shutdown 通过 |
| R1–R5 | 实例复用不误操作、嵌套 View 拒绝/恢复、旧绑定失效/新绑定可执行、getter 零次执行/恢复、无效配置和准确字段错误均通过 |
| 持久化/配置 | 版本 envelope、旧数据拒绝且不覆盖、配置不可变、数值边界与 NaN 拒绝通过 |
| Planning | 实际包的 Plan/Task Ref 操作、旧无类型 Ref 的业务拒绝与关闭通过 |
| SDK 输出 Hook | 真实 Worker 连续接收两次内容、reasoning 和 usage；调用方 metadata 不变，第二次只显示最新 View，关闭资源释放通过 |

Runtime 比基线减少 4 项测试：3 项只测 `promptRole` 透传，1 项只测已删除 getter 返回空 Map。SDK 比基线减少 11 项：不可达 Provider/history 分支及孤立持久化 helper。具有保留价值的生命周期、能力恢复、对象隔离和状态快照断言已迁移，没有通过 skip 或弱化错误断言完成清理。

主代理在集成时发现并修正了两处遗漏：删除 Desktop.drain 实现后遗留的 SPI 声明，以及真实 Worker 复用测试中的旧 Sandbox.dispose 调用。失败日志保留；后者改用 disposeAsync，继续证明旧 Sandbox 清理不影响同一物理 Worker 上的新实例。最终全量重新通过。

Runtime/SDK 的生产源码与类型合计 30 个路径，新增 104 行、删除 334 行，净减 230 行。这个口径排除测试、文档、应用调用方和生成脚本；不把行数下降解释为内存指标已经改善。

本轮本机验证目录：`/private/tmp/aotui-core-cleanup2-qa-jrdwl4wb`。`runtime-final-suite-result.json`、`sdk-suite-result.json`、`builds.json`、`packages.json`、`consumer.json` 和 `*-package-*-result.json` 保存命令、退出码和包身份，相关日志与 facts 同目录。临时目录可能被系统清理，本文件保留必要事实与结论。验证顺序为：纳入最终文档、打包、核对安装文件、运行公共消费；包哈希由目录中的 manifest 记录，避免将 tar 自身哈希写入它包含的文档。

Token Monitor / Planning 的工作区开发依赖未齐全，构建使用本轮源码副本、已存在的第三方开发工具和当前 AOTUI 包；不是声称完成了全仓依赖重装。实际消费测试使用离线安装的 tar，不使用这些构建链接。

2026-11-01 交付时，完整 Host 测试、真实模型对话、Electron 窗口验收未纳入本代理的通过范围；项目所有者的后续验收确认见下节。MEM-01 仍独立处理。工作期间出现的未跟踪 `skills/kenton-varda-infra/SKILL.md` 属于独立新增文件，本轮不修改或纳入清理提交。

## 2026-11-02 项目所有者验收确认

项目所有者在本次对话中明确说明：“当前最终版本的完整 Host／真实模型／Electron 验收：我已经测试完成”。

据此，该项更新为 **已完成（项目所有者确认）**，不再列为当前清理交付的待办，也不为同一版本重复要求验收。此记录是项目所有者提供的验收事实，不表示本代理重新运行了完整 Host 套件、真实模型或 Electron，也不改写上文的自动化测试计数与历史包证据。

此项确认时，剩余工作为独立的 MEM-01 内存专项。2026-11-02 的后续专项已完成 IDE 默认 TypeScript 进程配置修复，正式安装包两次、共六轮通过原门槛，详见 [MEM-01 修复与验收](mem01-closure-2026-11-02.zh-CN.md)。上文历史失败和测试范围保持不变。

本次代码清理、功能验收及 MEM-01 均已完成。若准备对外发布，再完成全仓干净环境依赖安装与构建验证，以及 Breaking Change 发布说明；本次没有对外发布。
