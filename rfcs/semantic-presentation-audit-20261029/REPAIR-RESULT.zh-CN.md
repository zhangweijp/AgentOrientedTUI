# Semantic 呈现修复交付

2026-10-29。基于根因审计实施，源码已修改，真实构建和集成验证已完成。**本次呈现修复的定向准出通过；仓库 Runtime 全量测试仍有 9 项既有失败，不能据此宣称整个项目全量准出。** 本记录不代替项目所有者对 Semantic 的产品验收，也不触发 Legacy 下线。

> 后续用户发现 Host 桌面预览显示 `No applications found.`。本轮原验证遗漏了 GUI 对快照格式的消费契约；该问题现已修复并补上 Source → GUI 与真实 Worker 预览验证，见 [桌面预览修复](preview-fix/README.zh-CN.md)。后续修复已重新构建共享 Host 产物，本文下面关于隔离构建和 dist 未变化的记录仅描述本轮历史事实。

## 修复判断与实现

问题发生在 Semantic 接入时附带改写的呈现协议、工具地址和应用页面。Semantic Core 的身份、观察与绑定机制不要求暴露到模型正文。修复保持原观察调用、关闭失效、动态能力、收据和容量约束，同时恢复公共界面的可读性。

| 根因 | 已实施修复 | 实现位置 |
| --- | --- | --- |
| DOM Producer 已输出 View 外壳，Source 再套一层 | 两个 Source 复用同一个包装函数：已有外壳补全属性，普通正文包装一次，保留正文与内部代码片段 | [公共包装](../../runtime/src/adapters/view-message.ts)、[Legacy Source](../../runtime/src/adapters/aotui-driven-source.ts) |
| Source 把内部身份和整个 App revision 写入每个 View | 模型外壳仅保留 id/type/name/app_id/app_name。内部身份继续留在 Context 与 Core；未变正文不随其他 View 的 revision 变化而改变 | [Semantic Source](../../runtime/src/adapters/semantic-aotui-driven-source.ts) |
| 每个 Binding 生成截断且带 hash 的函数名 | 按 Core 已聚合的逻辑 Tool 输出 `appName-ViewType-toolName`。常规名称无 hash；同名应用、非法/超长或歧义组合才做消歧 | 同上 |
| 稳定工具名需要明确的多 View 路由 | 单目标保留原 Schema；多目标注入必填 View 枚举 `aotui_view_id`。如业务占用该字段则逐次增加前导 `_`。只去掉 Source 注入字段，其余参数交给原 Context 捕获的 Binding | 同上及 [Source 回归](../../runtime/src/adapters/semantic-aotui-driven-source.test.ts) |
| SDK 将 Tool 展示错误地绑定到内部协议分支，且忽略 enabled | Tool UI 按 enabled 显示，ordinary-v1/v2 和 snapshot-value-v1 均覆盖。应用同时去掉停用工具留下的空列表项 | [Hook](../../sdk/src/hooks/useViewTypeTool.ts)、[SDK 回归](../../sdk/src/view-local-tools.test.ts) |
| 全局说明被缩成短提示，instruction 配置能力和 Desktop 日志丢失 | 恢复概念、结构、参数、Ref、收据与生命周期说明；恢复 instruction/path/env 优先级、最近 5 条日志、`system-*` 控制名。说明同时纠正旧文中“所有操作原子化”“所有 object 都传 Ref”等不成立的承诺 | [说明与加载](../../runtime/src/adapters/system-instruction.ts) |
| instruction View 全部被当作动态状态，每次观察重打时间 | instruction/state 分别进入 static/dynamic 区，保持 User 角色；当前内容摘要缓存只用于展示时间，停用和 dispose 清理，不参与授权和执行 | [Semantic Source](../../runtime/src/adapters/semantic-aotui-driven-source.ts) |
| 应用迁移时把页面和使用说明一起改简了 | 恢复 IDE 每目录标题、路径、树形线、已打开文件和工具区域；恢复三应用的使用步骤、View 职责与前置条件。IDE 树保留身份检查、句柄关闭、10,000 行和 200 KiB 限制，并约束排序缓冲 | [IDE 页面](../../demo-apps/aotui-ide/src/tui/ScopedIDEApp.tsx)、[目录读取](../../demo-apps/aotui-ide/src/core/ide-session.ts)、[Terminal](../../demo-apps/terminal-app/src/tui/RootView.tsx)、[Browser](../../demo-apps/lite-browser-app/src/tui/RootView.tsx) |
| 源码与 Driver dist 不匹配导致构建、测试误判 | 先构建 Driver，再构建 Runtime、SDK、三应用和 Host；使用 Driver 同源的 Tool 类型及 jsonSchema 工厂。整个验证使用隔离构建产物，不通过源码 alias 冒充产物通过 | [验证脚本](verify-repair.py)、[构建结果](repair-verification/attempt-2/results.json) |

多目标选择值是 View 中已显示的逻辑 id，不是内部 bindingId/observationId。真实测试验证了两个文件同时打开时只出现一个 `system_ide-FileDetail-edit_file`，编辑 B 不改变 A；关闭 B 后旧调用被拒绝，A 的旧有效观察仍准确指向 A。

## 实际 Messages 样本

以下摘自真实 Worker 输出，临时路径为展示方便缩写：

```xml
<view id="workspace" type="Workspace" name="Workspace" app_id="app_0" app_name="system_ide">

## Workspace

### 📁 [ 0 ] project

Path: /…/project

...
</view>
```

树形正文为：

```text
.
├── src/
├── demo.ts
└── other.ts
```

实际工具包括 `system_ide-Workspace-multi_open_file`、`terminal-TerminalConsole-new_terminal_and_send_command` 和 `system-close_app`。没有打开文件时，Workspace 当前可用操作中不出现 `batch_edit`；原生工具中不出现文件编辑能力。

[完整模型输入样本](repair-verification/attempt-2/final-messages.json)把真实 Worker 的 Source 投影交给构建后的 Driver 编排器，并加入测试用系统/用户消息。它验证应用说明、历史、动态状态和最新用户请求的位置，**没有调用真实 LLM**。初始 Browser 为 pending，用于测试随后通过公开生命周期工具启动；这不是对用户两份不同状态日志的逐字快照对比。

## 验证结果与范围

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Driver → Runtime → SDK → IDE / Terminal / Browser → Host 构建 | 7 项 exit 0；Host 包含 main/preload 构建 | [命令与结果](repair-verification/attempt-2/results.json) |
| 两个 Source 的回归 | 34 项通过，包含公共名称、单层包装、配置、目标选择、原观察、释放、unknown 与碰撞处理 | [Runtime 原始日志](repair-verification/attempt-2/runtime-tests.log) |
| SDK 全量 | 23 files，419 passed | [日志](repair-verification/attempt-2/sdk-tests-fixed-ui-expectation.log) |
| IDE 单测 | 9 suites，68 passed | [日志](repair-verification/attempt-2/ide-tests.log) |
| Driver Context/消息编排 | 2 files，9 passed | [日志](repair-verification/attempt-2/driver-context-tests.log) |
| 真实 Host + Worker + 标准安装 + 三应用 | 8 场景，21 次调用通过；覆盖 31 秒持有观察、双文件路由、最新正文、关闭重开、Terminal、Browser 本地页面 | [事实](repair-verification/attempt-2/host-worker-facts.json)、[日志](repair-verification/attempt-2/host-worker-e2e-localhost.log) |
| IDE 边界 | 22 场景通过 | [事实](repair-verification/attempt-2/ide-edges-e2e-facts.json) |
| IDE 容量 | 6 组通过；包含树行数和实际 UTF-8 字节的限内/临界/超限三点 | [事实](repair-verification/attempt-2/ide-capacity-e2e-facts.json) |
| Runtime 全量 | **2922 passed、9 failed、3 skipped、7 todo** | [日志](repair-verification/attempt-2/runtime-tests.log) |
| 修改前 HEAD 对照 | 同名 9 项失败全部复现 | [对照清单](repair-verification/baseline-head/results.json)、[第一组日志](repair-verification/baseline-head/existing-failures.log)、[第二组日志](repair-verification/baseline-head/existing-worker-failures.log) |
| 工作区核对 | 16 个变更代码/测试文件与验证副本逐文件匹配；共享 1,717 个 dist 文件未变化；`git diff --check` 通过 | [源码指纹](repair-verification/attempt-2/verified-source-sha256.json)、[最终核对](repair-verification/attempt-2/final-verification.json) |

9 项既有失败分别为：5 项单模式测试仍向已过滤能力索要 Binding；1 项仍按固定 TTL 断言观察过期；2 项旧 SDK/模式关闭组合仍期待可观察 Tool；1 项只读调用测试发现额外 SNAPSHOT_PREPARED 数量。这里确认的是它们在修改前也失败，未借本次呈现修复修改 Core 或删除这些断言。

修复过程中发现 SDK 一个原有测试把“停用工具后 DOM 完全不变”当成期望，这正好固化了本次缺陷。已改为检查业务文字不变、Tool UI 消失，并在每次语义发布中同时检查 Ref、注册表和 UI 的一致性，保留并加强原来的批量更新一致性验证。

首次隔离验证未装配历史兼容 fixture，产生路径缺失；补上显式只读基线路径后重跑。最初从 Runtime 本地 ai 导入 jsonSchema 的尝试因与 Driver 的 Schema 类型身份不同而构建失败，已撤销该尝试。首次 Browser 验证遇到沙箱禁止 localhost listen；随后在授权的本机端口测试中通过。相应失败日志均保留，没有覆盖成成功记录。

## 生效方式与尚未完成的验收

修复已在源码中，运行中的旧 Host/Worker 不会自动替换其已加载模块。保存当前工作并正常重启开发环境，根目录 `./run.sh` 会按依赖顺序重新构建并加载修复。不要只重建 Runtime 而继续加载旧 Driver、SDK 或应用 dist。本次没有重启用户正在使用的实例。

保留项目所有者已确认的语义：打开文件后才暴露编辑工具、Tool 返回收据、业务数据通过 View 呈现、关闭后旧绑定失效。因此，不会恢复未打开文件即可写入的 Workspace 旁路，也不会把已取消的 Terminal Ref 协议写回应用说明。

两份原日志的工作区集合还存在数据来源差异：旧全局状态与新的按 App/会话状态不能仅靠格式化变成同一份数据。本次未自动导入真实旧数据库；需要迁移时仍使用现有显式迁移入口和实际选定的来源，不能凭旧日志重建目录列表。

真实模型任务成功率、项目所有者亲自验收和 Runtime 全量测试债务仍需分别完成。本次结果不宣称干净安装兼容矩阵、长期资源/性能或 Legacy 退出已经验收。
