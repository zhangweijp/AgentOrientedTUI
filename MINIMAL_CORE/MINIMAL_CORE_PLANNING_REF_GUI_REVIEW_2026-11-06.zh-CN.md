# Planning 单目标 Ref 候选 GUI 独立复核

2026-11-06。结论：**APPROVED，限定于本次隔离候选的受控 GUI 操作链。** SDK 与 Planning 的源码、类型及 Worker 验收保持[此前独立裁决](MINIMAL_CORE_TYPED_REF_AND_PLANNING_REVIEW_2026-11-06.zh-CN.md)的范围。本记录补齐 GUI 证据，不改写此前 GUI 尚未完成的历史状态，也不批准共享采用、公共 API 发布或最终 Semantic 验收。

本次由 SRT Owner 操作原生界面，Minimal Core Owner 独立读取原始 Provider 请求、Host 日志、包文件及 CUA 工具输出。复核方没有重启 Host、操作桌面、读取私有数据库或凭据，也没有用执行者自己的 PASS 替代独立判断。

受控 Provider 只替换 `LLMClient.prototype.createProvider`，实际走 Host、Driver、SDK/Runtime 与 Planning 工具链。它从实际请求的页面文本选择 Ref，没有直接调用业务 handler，也没有预填 View 或操作结果。界面中创建了实际会话。确定性 Provider 证明连接和执行路径，不证明真实 LLM 已经理解协议。

| 实际操作 | 模型接口收到的工具参数 | 独立核对结果 |
| --- | --- | --- |
| 创建计划、阶段和任务 | 标题及初始内容，无需 Ref | 成功收据；当前详情显示新计划、阶段、任务。 |
| 修改任务标题 | `task: "Task:pending_tasks[0]"` 与普通 `title` | Ref 来自此次请求的 `plan_detail`；任务名称变为 GUI Updated Task。 |
| 在当前阶段新增任务 | `phase: "Phase:current_phase"` 与普通 `title` | Ref 来自此次请求的 `plan_detail`；页面同时显示修改后的任务与 GUI Additional Task。 |
| 关闭当前活动计划 | `{}` | 成功收据；详情退出，PlanList 显示 No active plan，列表对象保留。 |
| 从列表重新打开计划 | `plan: "Plan:unfinished_plans[0]"` | Ref 来自此次请求的 `plan_list`；重开后两个任务及其修改均保留。 |

原始 `provider.jsonl` 共 10 次模型接口请求，其中 5 次输出业务调用。Driver 日志对应 5 次执行完成；每个调用在紧随其后的请求中有且只有一条对应的工具收据，收据只包含结果消息。每次请求同一个当前 View 只有一份。PlanDetail 工具数量依次为 `[0,7,7,7,7,7,7,0,0,7]`，与关闭和重开的页面变化一致。三个对象参数都是完整 Ref 字符串，没有要求模型另传 `plan_id`、`phase_id`、`task_id`。文件路径的既有合同未改动。

`read_thread` 能提供 CUA 调用状态，但未返回其原始 AX 输出。因此本次继续只读该 chat 的本地原始记录，按本轮 turn ID 和 call ID 提取 38 组 CUA 调用/结果，保留来源行号、原始行 SHA 和时间。11 处界面断言分别证明工具卡片、页面内容和关闭/重开状态。复核方另外查看了该轮原始截图，确认当前阶段下同时呈现两个任务；截图从原始工具结果解码保存，未编辑或补画。完整 Ref 的模型文本与 GUI 链接 URL 需区分：原生 AX 会把链接 scheme 小写并转义方括号，这没有改写 Provider 实际收到的 `Task:pending_tasks[0]`。

精确身份核对通过：

| 输入 | SHA-256 | 本次逐件核对 |
| --- | --- | --- |
| SDK 最终本地候选 | `7573cc0b73d1aa480edf68847617da1d9c85e4bab616bfebfd5b6f124baa5e5b` | 90 件包文件相同 |
| B23 Runtime | `46c39d592ce11ec950ab10dbf15568b55278d0a5c3702366feb0c443e063a7e6` | 388 件包文件相同 |
| Planning 候选 | `ac41d296facd7503d5838a57dc0507aee3c1a32e9beba576505143d88e8140c1` | 46 件包文件相同 |
| 执行方 GUI verification | `0f6e11299ff85fab81e6319151de4e379fa83f2076402d88ccc4694c7480071e` | 所引 9 份证据指纹相同 |

ESM 解析独立核对指向本隔离目录中的 SDK、Runtime 和 Driver。Host 沿用冻结 B25 所配套的 SRT M4.3 构建，共 758 件 dist 文件；10 件只替换了已记录的私有隔离根路径，其余逐字相同。Driver 16 件 dist 文件以及 renderer 4 件文件均与冻结来源逐字相同。这不是共享树当前 Driver 的集成验收。

最初启动因新副本遗漏 `host/dist-gui` 而产生 ERR_FILE_NOT_FOUND。SRT Owner 补入 4 件原封不动的 renderer 文件后通过原生 Cmd+R 继续。原 stderr 和修正记录均保留；这次脚手架修正不能写成 Host 预览缺陷已修复。此前锁屏尝试的零调用记录也保留在独立目录中。

运行进程 PID 3289 的实际入口、userData、sessionData 和 storagePath 均属于新隔离目录。网络记录的 6 次模型目录请求均在网络前被拒绝；业务模型响应由进程内 Provider 提供。本轮没有真实模型推理。完成后日志显示 Main 关闭、一个会话清理、Driver stopped/disposed；chat 原始命令完成状态独立核对为 exit 0。没有采集 GUI Runtime 的结构化资源关闭回执，不能据此追加“所有内核计数均已归零”的断言。

独立证据位于 [owner-review](../review-evidence/minimal-core-planning-ref-gui-20261106/owner-review/recheck-result.json)，包含可重跑的只读检查脚本、原始 CUA 提取、原始截图、进程完成证明和最终签收。复核脚本第一次选错 ADD_TASK 收据的 call ID，随后改为原始提交调用已返回的成功结果；精确纠正记录保留，没有改动候选或弱化断言。

仍未覆盖的风险：本轮每次通过 Chat→TUI 切换后查看页面，未验证一直停留在 TUI 的自动更新，也未验证操作前首次预览。**MC-HOST-PREVIEW-01 保持 OPEN。** 真实 LLM 自行选择 Ref 仍需手测；整个数组、多 Ref、可选 Ref 及 SRT-05 的新观察自动撤销旧资格仍未完成。SRT-02 不因单目标 GUI 验收通过而整体关闭。

下一项交付由 SRT Owner 独占准备：在本次进程已关闭、证据封存之后，沿用此前已获授权的私有模型配置准备独立手测状态。准出条件是本裁决、SDK/App 裁决和包身份可追溯；旧 B25、用户原 Host 状态与封存 GUI 证据不变；说明明确入口、当前支持范围和已知预览问题；交接后自动脚本不能再重置用户状态。不得自动发送真实模型请求。执行 Prompt：

> 只处理 `.tmp/planning-ref-manual-20261106` 的手测交接。保留 `evidence/gui` 的原 verification/completion，另增独立 GUI 裁决引用；依据既有授权准备私有 DeepSeek 配置、空业务/聊天状态和仅启用 Planning 的验收 Agent，不输出凭据。核对已关闭进程、精确包、启动/停止脚本与交接保护，再更新 ACCEPTANCE 文档并交还入口。不要启动真实推理、修改共享生产代码、重置已交接状态或宣称 Semantic 验收完成。

下一批工程范围为 MC-HOST-PREVIEW-01 的**只读复现与最小修复建议**，独立于本候选采用。由执行 Codex 持有自己的新隔离目录，Minimal Core 复核；不得同时占用 SRT 的桌面/手测副本。准出条件：同一固定基线分别证明首次页面和刷新后页面的实际来源；说明预览缓存、提交时点和 Agent Observation 的所有者；用确定性真实 Host 入口复现差异，保留未复现结果；给出最小文件范围和必要回归，不在本阶段改生产文件。执行 Prompt：

> 只读核对 MC-HOST-PREVIEW-01：Driver 已有正确 Planning 页面而 Host TUI 首次预览可能仍为空。先核对既有证据与实际 Host 源码，区分首次读取和持续刷新。新建你独占的隔离诊断目录，不访问私有 profile/DB/凭据，不启动 GUI 或外部模型。若可通过真实 Host/Bridge 入口确定性重现，提交失败证据、准确责任链与最小修复建议；若无法重现，如实交付边界，不能用缓存结构推断代替行为证据。禁止 App 加延迟/轮询兜底，禁止预览替换 Agent 当前 Observation，禁止新状态管理器、SDK/Runtime 协议扩展、共享覆盖或发布。等待独立复核后再安排修复实施。
