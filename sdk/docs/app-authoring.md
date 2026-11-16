# 在 Worker 中运行普通 TypeScript 或 Preact App

用 `defineViewType<Context>()({ name, tools })` 在一处声明操作名、说明、TypeBox 参数和 `execute({ input, context })`。无业务参数的工具可以省略 `inputSchema`。每个页面提交自己的 `context`。下面两版工作项 App 共用声明。

- 复制 [共享 ViewType、业务状态和操作声明](examples/work-items.ts)。
- 复制 [普通 TypeScript 入口](examples/work-items-plain.ts)，或者复制 [Preact 入口](examples/work-items-preact.tsx)。

两个独立页面共享一份工具的完整 Preact 示例见 [计数器](app-tools.md)。

在同一目录编译所选入口与共享模块，保留入口的默认导出。所需包为配套版本的 `@aotui/sdk`、`@aotui/runtime` 和 `typebox`。Preact 入口另需 `preact`。普通 TS 可使用 NodeNext 模块解析、`lib: ["ES2022"]`、`types: []` 和 `skipLibCheck: false`；Preact 示例启用 `jsx: "react-jsx"`、`jsxImportSource: "preact"` 和 DOM lib。两者的 Host 运行环境为 Node。

## 发布和执行

普通 TypeScript 从 `@aotui/sdk/app` 导入 `createApp`、`defineViewType` 和 `createView`。工厂登记 `viewTypes`，在 `initialize` 中为每个逻辑页面保留一个 `createView(type, { id, kind, render })` handle。`render` 返回本次的 Markdown 正文、Ref 和本页 `context`。`publish({ views })` 传入 App 当前打开的全部 handle，返回 `{ status: 'prepared', sourceEpoch }`。同一个 handle 持续提交时保留挂载身份。关闭后重新加入，或用同 id 的另一个 handle 替换，都产生新挂载。

Preact 从 `@aotui/sdk` 导入 `createTUIApp`、`defineViewType` 和 `View`。页面传 `<View type={Page} id="detail" kind="state" context={...}>`，用 `useDataRef` 或 `useArrayRef` 发布页面数据。SDK 在实际提交阶段捕获整帧。

SDK 用当前候选的页面上下文构建绑定，在准备该页时调用可选的同步 `enabled(context)`。返回 `false` 会在成功提交后撤销该页对应操作的资格。上下文是 App 持有的对象或函数引用，可以携带 setter 或服务。需要随提交换一组上下文字段时，传入新的对象。该引用随页面绑定留在执行端，业务参数与 Ref 继续使用原来的 JSON 边界。Root 可以用 `<ToolCatalog />` 列出 App 登记的 ViewType 工具名。普通 TypeScript 可以调用 `getToolCatalog(viewTypes)` 取静态目录。

没有工具的页面用 `defineViewType({ name })` 声明，发布时只提供自己的正文和 Ref。工具调用的 `view_id` 由模型选择，Runtime 校验后调用该页的 handler。handler 收到的 `input` 包含深只读的业务字段和已解析的 Ref。显式 Ref 可以来自同一观察中的另一页。

两个 SDK 入口都要求 View id 非空，仅使用 ASCII 字母、数字或下划线，在 App 的当前挂载集合内唯一。示例的两个 Item 分别使用 `b` 和 `billing_export_2026_11`。View 元数据、Snapshot 和观察仍有各自的字节限额。直接使用纯 Core 构建 Producer 时，View id 可以使用更宽的字符集，须满足非空、无点及唯一性。

Ref 名在所属 View 内唯一，禁用点号。使用 `formatRef(label, id, refType)` 或 hooks 返回的格式化函数按字面量显示 label。`[Selected](Data:selected)` 位于 `billing_export_2026_11` 时，显式 Ref 参数为 `billing_export_2026_11.selected`。数组元素地址为 `billing_export_2026_11.items[0]`，局部名为 `items[0]`。空数组仍有整体 Ref。普通文本按字面值传递。

Tool 声明使用 TypeBox。普通字段和解析后的 Ref 允许有限 JSON 数据，包括 null、整数、混合数组和嵌套对象。Ref 可选 `schema` 校验源数据，`refParam` 则校验调用时选中的实际值。相同的源 Ref 可以用于不同目标约束。可选字段省略后仍缺失，`default` 作为 schema 注释保留。

本地校验支持对象属性、必填字段、布尔 `additionalProperties`、数组 `items`、`enum`、`const`、字段及 Ref 值的 `anyOf`、字符串长度与 Unicode `pattern`、数值上下限、数组长度、`description` 和 `default`。`Type.Unknown()` 与 `Type.Any()` 仍受普通 JSON 捕获限制。显式 Ref 可作直接参数，也可作直接数组参数的元素。声明诊断区分非法、不支持和超限，并报告代码与 Schema 路径。完整 Tool profile 连同内部标记的上限为 64 KiB canonical JSON UTF-8。 [参数合同与错误码](tool-parameters.md)

### 普通 TypeScript 的打开准入

对于可撤回的导航，先暂存新页面，再调用 `publish({ views: [...openViews, nextView] }, { opening: true })`。候选须包含全部拟打开页面。局部准备成功后，再提交 App 的导航状态。请只在原页面的状态、Ref 和 handler 都能保留时使用 `opening: true`。

托管 Worker 会按默认完整观察的容量检查已校验的候选。新增页面超限时，`publish` 同步抛出 `OBSERVATION_CAPACITY`，异常带有路径和恢复提示。App 可以放弃这次导航并把错误码和提示作为打开操作的收据。原投影健康时，已有页面可继续操作。关闭已开页面或由 App 减少页面内容后，可以再次打开。

### 业务结果与投影

Tool handler 返回收据，业务数据通过 View 呈现。一般发布故障保留最近有效快照和诊断，并暂停新调用直到 App 提交有效帧。已经完成的业务写入应保留成功收据。普通 TypeScript 示例先更新 App 状态，再单独捕获 `publish` 的异常，返回简短的同步失败提示。修复呈现后，从 App 当前持有的业务状态重新调用发布即可。 [普通 TypeScript 示例](examples/work-items-plain.ts)

### Preact 的局部提交反馈

`useAppRuntimeContext().prepareProjection(update)` 将这轮调度中的组件提交收集起来，等调度队列完成后统一准备完整候选。它返回局部 `PreparedProjection`，或以发布错误拒绝。写入已完成时，App 可捕获投影错误并在成功收据中说明同步情况。相同状态无需再次准备投影。

可放弃的新增页可调用 `prepareProjection(update, { revert })`。现有页面应保持挂载，两个回调都要同步安排状态更新。异步函数或返回 Promise／thenable 的回调会被拒绝。新增页因 `OBSERVATION_CAPACITY` 被拒绝时，SDK 调用 `revert` 并在恢复队列完成后验证原快照、挂载与执行绑定确实恢复。实际重挂和无效渲染沿投影故障路径报告。导航持久化应在局部准备成功后执行。 [Preact 文件示例](examples/file-app.tsx)

`PreparedProjection` 确认本地准备成功。Host 的 flush 确认当前来源被 Runtime 接收。宿主再采用与本轮 Messages 和 Tools 对应的 Observation。

使用 `registerCleanup({ stop, close })` 或 Preact 的 `useAppLifecycle` 登记 App 自有资源。异步准备结束后检查 `signal.aborted`。关闭时已经开始的初始化与资源登记由 Runtime 收尾。

## Manifest

例如把普通 TS 入口编译为 `dist/work-items-plain.js`，在 App 的 `package.json` 中设置 `"type": "module"`、`"main": "./dist/work-items-plain.js"` 和版本。Preact 使用它对应的输出文件。仓库内可以执行 `node scripts/generate-aoapp.mjs <app-dir>` 生成 `aoapp.json`。仓库外分发同样形状的静态文件，并保持 `app_name` 与默认导出的 factory 一致。

```json
{
  "app_name": "work_items",
  "version": "0.1.0",
  "toolAuthoringProtocol": "view-type-tools-v5",
  "persistenceSupport": "state-session-v1",
  "appLifecycleSupport": "app-lifecycle-v2",
  "entry": { "main": "./dist/work-items-plain.js" }
}
```

生成清单后，宿主可以安装 App、采用观察并调用其中的 Ref。完整示例见 `@aotui/runtime` 包内 `docs/semantic-host-integration.zh-CN.md#source-host-example`。

`TOOL_INVALID_ARGS` 指向原始参数路径，`REF_VALUE_UNSUPPORTED` 指向解引用后不符合目标 schema 的值。直接调用 `desktop.installDynamicWorkerApp` 或 `runtime.installDynamicWorkerApp` 时，拒绝异常的 cause 链保留开发者诊断。`AppRegistry.installAll` 返回逐 App 的 installed、registered 或 failed。成功项携带 ID，失败项携带阶段与诊断，其他 App 继续安装。已运行 App 的投影校验失败会在公开观察和 Agent Driver 诊断中带出有界的 code、message 和 path。

线路 schema 保留业务约束，Ref 在模型侧表现为地址字符串。具体 provider strict 模式的能力由 Host/provider 适配负责。

## 迁移

现有 Preact App 仍使用 `createTUIApp({ component, ... })`。使用 SPI 的自定义 factory 从 `initializeComponent(container, context)` 迁移到 `initialize(context)`，返回带 `close()` 的实例。旧 `ComponentFactory`、`ComponentRenderer` 及 `kernelConfig.component` 退出，SDK 和 Runtime 需要配套重建。同一 SDK 构建的不同模块副本可以互用 ViewType descriptor。运行中的页面 handler 由各自 Worker 持有。旧工具声明和页面属性的迁移见[配套迁移](migration.md)。
Preact App 可以用 `useLLMUsage` 读取所属 Desktop 的模型用量。需被动更新的 App 可设 `signalPolicy: 'never'`，使新投影进入下一次观察，同时抑制自动更新信号。
