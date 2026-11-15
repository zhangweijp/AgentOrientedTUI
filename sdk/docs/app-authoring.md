# 在 Worker 中运行普通 TypeScript 或 Preact App

同一个 ViewType 的工具定义只声明一次。每个页面实例提供自己的 handler，可以读取和更新该页的状态。下面两版工作项 App 共享定义并各自维护运行状态。

- 复制 [共享 ViewType 声明、状态和 handler](examples/work-items.ts)。
- 复制 [普通 TypeScript 入口](examples/work-items-plain.ts)，或者复制 [Preact 入口](examples/work-items-preact.tsx)。

在同一目录编译所选入口与共享模块，保留入口的默认导出。所需包为配套版本的 `@aotui/sdk`、`@aotui/runtime` 和 `typebox`。Preact 入口另需 `preact`。普通 TS 可使用 NodeNext 模块解析、`lib: ["ES2022"]`、`types: []` 和 `skipLibCheck: false`；Preact 示例启用 `jsx: "react-jsx"`、`jsxImportSource: "preact"` 和 DOM lib。两者的 Host 运行环境为 Node。

## 发布和执行

普通 TypeScript 从 `@aotui/sdk/app` 导入 `createApp`、`defineViewType` 和 `createView`。工厂声明 `viewTypes`，在 `initialize` 中为每个逻辑页面保留一个由 `createView(type, { id, kind, render })` 创建的 handle。`render` 捕获本次的 Markdown 正文、Ref 和局部绑定。`publish({ views })` 传入 App 当前打开的全部 handle，返回 `{ status: 'prepared', sourceEpoch }`。同一个 handle 持续提交时保留挂载身份。关闭后重新加入，或用同 id 的另一个 handle 替换，都产生新挂载。

Preact 从 `@aotui/sdk` 导入 `createTUIApp`、`defineViewType` 和 `View`。工厂同样声明 `viewTypes`。页面用 `<View type={Page} id="detail" kind="state" bindings={...}>` 提供操作，用 `useDataRef` 或 `useArrayRef` 发布页面数据。SDK 在实际提交阶段捕获整帧。

每个页面提供其 ViewType 中所有工具的 `execute`。可用性用该页的 `enabled: false` 控制。模型调用时传入必填的 `view_id`，SDK 的业务输入 Schema 与 handler 参数只包含业务字段。显式 Ref 参数可以来自同一观察中的另一页。

两个 SDK 入口都要求 View id 非空，仅使用 ASCII 字母、数字或下划线，在 App 的当前挂载集合内唯一。示例的两个 Item 分别使用 `b` 和 `billing_export_2026_11`。View 元数据、Snapshot 和观察仍有各自的字节限额。直接使用纯 Core 构建 Producer 时，View id 可以使用更宽的字符集，须满足非空、无点及唯一性。

Ref 名在所属 View 内唯一，禁用点号。使用 `formatRef(label, id, refType)` 或 hooks 返回的格式化函数按字面量显示 label。`[Selected](Data:selected)` 位于 `billing_export_2026_11` 时，显式 Ref 参数为 `billing_export_2026_11.selected`。数组元素地址为 `billing_export_2026_11.items[0]`，局部名为 `items[0]`。空数组仍有整体 Ref。普通文本按字面值传递。

Tool 声明使用 TypeBox。普通字段和解析后的 Ref 允许有限 JSON 数据，包括 null、整数、混合数组和嵌套对象。Ref 可选 `schema` 校验源数据，`refParam` 则校验调用时选中的实际值。相同的源 Ref 可以用于不同目标约束。可选字段省略后仍缺失，`default` 作为 schema 注释保留。

本地校验支持对象属性、必填字段、布尔 `additionalProperties`、数组 `items`、`enum`、`const`、字段及 Ref 值的 `anyOf`、字符串长度与 Unicode `pattern`、数值上下限、数组长度、`description` 和 `default`。`Type.Unknown()` 与 `Type.Any()` 仍受普通 JSON 捕获限制。显式 Ref 可作直接参数，也可作直接数组参数的元素。声明诊断区分非法、不支持和超限，并报告代码与 Schema 路径。完整 Tool profile 连同内部标记的上限为 64 KiB canonical JSON UTF-8。 [参数合同与错误码](tool-parameters.md)

Tool handler 返回收据，业务状态通过下一次 View 发布呈现。普通 TS 的 `publish` 同步校验候选帧。失败异常包含 code、path 和原因。最近有效快照、已提交的 View 和 Tool 身份保留，App 暂停新调用直到提交有效帧。原样提交可恢复原有身份和调用资格，成功关闭后再打开会分配新身份。已产生业务副作用的操作由 App 记录真实结果，恢复时只补交投影。

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

现有 Preact App 仍使用 `createTUIApp({ component, ... })`。使用 SPI 的自定义 factory 从 `initializeComponent(container, context)` 迁移到 `initialize(context)`，返回带 `close()` 的实例。旧 `ComponentFactory`、`ComponentRenderer` 及 `kernelConfig.component` 退出，SDK 和 Runtime 需要配套重建。同版本 SDK 副本可以互用 ViewType descriptor。运行中的页面 handler 由各自 Worker 持有。旧 App 级绑定的迁移见[配套迁移](migration.md)。
Preact App 可以用 `useLLMUsage` 读取所属 Desktop 的模型用量。需被动更新的 App 可设 `signalPolicy: 'never'`，使新投影进入下一次观察，同时抑制自动更新信号。
