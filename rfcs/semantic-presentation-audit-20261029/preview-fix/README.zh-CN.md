# Host 桌面预览修复

2026-10-29。修复用户报告的切换到 AOTUI 桌面预览后显示 `No applications found.`。本次修改集中在 Host，没有继续修改 Semantic Core、SDK 或模型 Messages。

## 根因与遗漏

1. `HostManagerV2.getSnapshot()` 和 `DesktopManager.getSnapshot()` 都调用 `readSemanticDesktopSnapshot()`。
2. 该函数直接拼接 Semantic Source 面向模型的 Messages。这些 Messages 是独立的 `<view app_id="…">`，`<desktop>` 消息位于它们之后。
3. GUI 的 `TuiParser` 消费的是另一种已有格式：先 `<desktop>`，再按 `<application>` 分组的 Views。解析器只在 `</desktop>` 后查找应用分组。
4. 结果是安装和运行中的应用存在，但 GUI 得到空数组，显示 `No applications found.`。

上一轮验收检查了模型 Messages、Tool 调用和 Worker 生命周期，没有把实际 Semantic Source 输出交给 GUI 解析器及组件验证。这是消费端契约覆盖遗漏。增加的回归用例在修复前实际得到 **7 failed、2 passed**，原始结果保留在 [before.log](before.log)。

## 修复边界

- [Host 快照适配器](../../../host/src/core/semantic-desktop-snapshot.ts)继续独立获取、释放 Semantic 观察；按 View 外壳的 `app_id` 将正文归属到已安装应用，输出 GUI 原有的应用分组格式。应用列表来自安装状态，因此 pending、closed 或没有 View 的应用不会被误判为未安装。
- [GUI 解析器](../../../host/src/gui/components/TuiParser.ts)读取状态及正确解码属性；[应用组件](../../../host/src/gui/components/ApplicationBlock.tsx)显示实际状态，并按 View id 保持当前标签。选中页面关闭后回到仍存在的页面。
- [桌面组件](../../../host/src/gui/components/TuiDesktopViewer.tsx)在已有应用时直接选择有效应用，消除初次渲染时的错误空态。

GUI 分组由 Host 负责。模型仍获得独立的最新 View Messages；没有把 GUI 的 `<application>` 包装塞入 Core，没有调用 Legacy 快照入口，也没有通过预览替换或释放 Agent 持有的观察。

## 验证结果

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 真实 Semantic Source → Host 适配 → GUI 解析与 React 渲染 | 9 项通过；覆盖三应用分组、同名 Root 隔离、应用切换、打开/更新/关闭文件、标签保持、状态、转义名称和真正空桌面 | [测试](../../../host/test/gui/semantic-desktop-preview.test.tsx)、[单独运行](after.log) |
| 上述回归与已有 App 会话流程联合运行 | 2 files、10 passed | [日志](preview-and-session-tests.log) |
| Host TypeScript、Electron main/preload、GUI 构建 | `npm run build:all` exit 0 | [日志](host-build-all.log) |
| 真实 Worker + 标准安装 + 三应用 | 8 场景、21 次调用通过；新增实际预览解析断言，验证 IDE 最新正文、关闭移除、Browser 从 pending 到 running 及页面出现 | [测试](../../../host/test/semantic-host.e2e.ts)、[事实](host-worker-facts.json)、[日志](host-worker-e2e.log) |
| 预览和 Agent 观察相互独立 | 在 Agent 持有观察期间多次读取并释放预览；原绑定在 31 秒后仍可调用，关闭后的旧绑定仍被拒绝 | 同上真实 Worker 测试 |

[checks.json](checks.json)记录命令、退出码和耗时。Worker 测试使用临时工作区、临时应用数据及 `127.0.0.1` 临时端口的网页 fixture，没有调用真实 LLM，也没有对用户当前桌面做操作。React 渲染在 happy-dom 中验证，未冒充用户正在运行的 Electron 实例验收。

## 生效与范围

此次已在当前工作区重新生成 Host 的 `dist` 与 `dist-gui`，包括主进程、preload 和前端。正在运行的主进程仍持有旧代码，正常退出并重新启动 Host 才会加载修复；只刷新前端不能替换已加载的主进程代码。本次没有强制停止用户正在使用的 Host。

本记录补充上一轮的 [呈现修复交付](../REPAIR-RESULT.zh-CN.md)，不覆盖其历史结果；上一轮“共享 dist 未变化”仅适用于上一轮的隔离验证。此次明确重建了共享 Host 产物。本次没有重新声明 Runtime 全量测试或项目所有者验收通过，也不构成 Legacy 退出依据。
