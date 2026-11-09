# Batch 25 GUI 补验裁决

2026-11-06。**APPROVED，范围限于单个必填 Plan Ref 的隔离手测入口，以及实际打开/关闭后查看对应页面的流程。** 原先因锁屏未完成的操作链 GUI 门槛已经补齐。首次加载时的 TUI 预览刷新缺陷仍然 OPEN，本裁决不将它计为通过；真实模型理解、共享协议采用和所有者最终 Semantic 验收仍未完成。

原 `MINIMAL_CORE_BATCH_25_REVIEW.zh-CN.md` 的 CHANGES_REQUESTED、原执行者清单、首次缓存变化与环境失败全部保留，本文追加本轮新证据和限定范围内的新结论。不是把此前未验证的 GUI 改写为已经验证。

## 实际完成的验证

SRT Owner 独占 CUA 操作，Minimal Core 没有操作窗口。使用新目录 `.tmp/minimal-core-ref-gui-verification-20261106/`，实际 Electron.app 为该目录下的独立副本。真实凭据手测环境保持冻结。provider 只替换 `LLMClient.createProvider`，真实 Host、Driver、`LLMClient.call`、`streamText`、Source、Worker 和 Planning 均运行原实现。

| 时机 | 实际模型请求里的当前状态 | GUI 独立观察 |
| --- | --- | --- |
| 打开前，请求 1–3 | 有 `GUI Ref Plan` 和完整 `Plan:unfinished_plans[0]`；无 PlanDetail，详情工具 0 个。 | 初次 TUI 预览曾错误停留在空列表，单列缺陷。 |
| open_plan 后，请求 4–5 | PlanDetail 已出现，详情工具 7 个。 | 实际工具卡片 Input 为完整 Ref，Output 仅 `Plan opened.`；从 Chat 切回 TUI，详情显示原 Plan ID、描述、阶段和任务。 |
| close_plan 后，请求 6 | PlanDetail 退出，详情工具恢复为 0 个。 | 实际关闭收据为 `Active plan closed.`；切回 TUI 后只有 Root/Plan List，显示 No active plan，列表及完整 Ref 仍在。 |

六次受控 provider 请求中，业务只调用两次：`b25-gui-1-open` 和 `b25-gui-2-close`。前者的完整 Ref 从该次实际请求中的页面链接取出；业务绑定只进入一次，实收完整 Plan，包含真实合成数据库里的阶段与任务。没有预填聊天、工具卡片、收据或 View。外部模型请求为零。

SRT Owner 通过 Cmd+Q 正常退出 PID 90466，确认进程不存在、shell 退出 0，日志显示 Host/session/Driver 清理。没有从该 GUI 过程额外宣称结构化 Runtime `resourcesReleased` 报告；此前独立 Worker/Source 的资源检查另有原件。

SRT Owner 的最终记录 SHA-256 为 `790be40a0020f44365e4fe5671434bf9ee77cb944c4322e284119aacae340cca`。Minimal Core 独立核对该记录引用的六份原始日志、六轮请求中的页面/工具变化、业务绑定实收对象和三个实际 Electron 数据路径。没有将别人操作的 GUI 冒称自己重跑。

- [独立 GUI 原件](../.tmp/planning-app-install-20261106/gui-followup/gui-verification.json)
- [Minimal Core 原始记录核对](../review-evidence/minimal-core-batch-25/gui-followup/owner-review/independent-gui-checks.json)
- [更新后的人工验收步骤](../.tmp/planning-app-install-20261106/REF_ACCEPTANCE.zh-CN.md)

## 改动、隔离与发现

本轮没有新的内核重构或作者概念，不按“删掉多少代码”记成绩。新副本九个 Host 源文件相对冻结版本只有固定目录替换；Driver 与 Planning 业务源码不变。局部 provider、网络阻断和数据种子仅属于验证脚手架，未进入公共 API。SDK 90 件、Runtime 388 件包载荷由 SRT Owner 独立逐字核对，匹配已签收原包。

首次 GUI 只有 Projects 首页，原因是预置主题未关联项目。修订只使用现有 DB API，在新副本添加合成空项目并关联原主题；两张 messages 表仍为空，未伪造调用。手测指南也补充真实首次入口：Open Folder → 选择空工作目录 → New Session/选择验收 Agent。

原手测环境的 1,507 件静态文件由双方核对无漂移，私有状态 50 个文件由 SRT Owner 独立检查无漂移；Minimal Core 未读取该私有状态。两次实际 Host 启动的 `userData`、`sessionData` 和默认 session 存储路径均指向新副本。

以下事实保留：首次 sandbox 启动退出 134，随后同一隔离命令获准执行并成功；一次 CUA `getApp` 打开了新复制 Electron 的默认页，随后退出，但其 profile 未捕获，不能宣称所有用户缓存均未变化；第一条 `typeText` 丢失下划线成为 `B25GUIOPEN`，没有派发工具，改用精确 paste 后才有上述两次业务调用。这些不计为有效业务反例，也不改写原 B25 的四件缓存/WAL 变化记录。

## 尚未解决：首次预览刷新

登记 **MC-HOST-PREVIEW-01 / OPEN**：同一启动过程中，模型请求已经包含有效 Plan 与 Ref，TUI 预览仍显示 No unfinished plans。打开/关闭后切回 TUI 的页面正确，不等于已验证全程自动实时刷新。

只读定位依据：PlanningApp 在异步加载后 `setPlans`；GUI App 在进入 TUI/切换主题时请求快照；ChatBridge 保存预览缓存，普通聊天/工具事件未主动刷新它；Host 的预览读取通过 `readSemanticDesktopSnapshot` 使用独立短期 Source，并在 finally 释放。上述五个相关文件与 SRT M4.3 Git 原字节一致。**这只能定位优先调查的路径，不能单凭文件未改就认定该现象一定既存，也没有实验证实完整根因。**

责任优先落在 Host 预览获取、缓存与更新通知的衔接。不能要求每个 App 重复提交、加延时来补偿，也不能为修 GUI 预览而替换 Agent 正在使用的 Observation。本问题与已经验证的 Ref 取原对象、工具执行及 Agent 下一轮当前投影分别报告。

## 下一批具体范围与准出

下一批仅处理 MC-HOST-PREVIEW-01，先在独立无凭据环境对照复现。对比 M4.3 原包与本批候选，证明异步数据提交后 GUI 何时取得、丢失或保留旧预览；不重复 Ref 的 A/B 与非法参数测试，不扩大数组、多选或旧观察协议。

准出条件：已有预览/通知接口的责任断点有实证；若提交修复候选，只改必要 Host 路径，不加轮询、任意等待或新状态管理器；无需执行一条业务命令，初次已提交的数据也能在 GUI 观察到；GUI 检查不替换 Agent 的当前观测，切换主题和关闭后的订阅清理可验证。涉及公共协议/API 的调整须提交上级决定，不以本任务自动授权。冻结手测环境及共享生产代码继续保持。

Codex Prompt：

> 针对 MC-HOST-PREVIEW-01，在新无凭据副本先做最小真实对照复现，保留原 M4.3 与候选结果；不要重新盘点全仓。追踪已提交页面到 Host 预览缓存的通知与读取顺序，明确 App、Runtime、Host 各自已有责任。只在证据能支持现有 Host 接口内的最小修复时交隔离候选；需要新协议或公开 API 时停止扩大并报告。禁止轮询/任意延迟、App 重复提交补偿、让 GUI 采用 Agent 观测或修改冻结状态。你不是唯一工作者，不回滚他人修改；提交真实前后例与清理证据，由负责人独立复核，不自批，不应用共享代码或发布。
