# 在 Worker 中运行普通 TypeScript 或 Preact App

普通 TypeScript 使用 `@aotui/sdk/app` 的 `createApp`。Preact 使用 `@aotui/sdk` 的 `createTUIApp`、`View` 与 `AppTools`。两者可共享同一份 TypeBox ToolSet，分别维护自己的 App 实例。下面两版工作项 App 使用同一组操作和 Ref。

- 复制 [共享 ToolSet、状态和 handler](examples/work-items.ts)。
- 复制 [普通 TypeScript 入口](examples/work-items-plain.ts)，或者复制 [Preact 入口](examples/work-items-preact.tsx)。

在同一目录编译所选入口与共享模块，保留入口的默认导出。所需包为配套版本的 `@aotui/sdk`、`@aotui/runtime` 和 `typebox`。Preact 入口另需 `preact`。普通 TS 可使用 NodeNext 模块解析、`lib: ["ES2022"]`、`types: []` 和 `skipLibCheck: false`；Preact 示例启用 `jsx: "react-jsx"`、`jsxImportSource: "preact"` 和 DOM lib。两者的 Host 运行环境为 Node。

## 发布和执行

普通 TS 在 `initialize` 中准备业务数据，然后调用同步 `publish({ views, bindings })`。每次传入完整 App 的当前 View 和绑定。省略的 View、Ref 会从投影移除。保留相同 id 和类型的 View 沿用实例身份。关闭后重开会得到新身份。声明了 ToolSet 时，每帧提供对应 handler，使用 `enabled: false` 撤下某个操作。多份同类型 View 共享该类型的 Tool。

Preact 通过 `View`、`useDataRef`、`useArrayRef` 和 `AppTools` 参与实际提交。业务状态由组件管理，只有本次提交参与的 owner 会重新捕获。

两个入口的 View id 都使用 2–15 位 ASCII 字母、数字或下划线。Ref 名在所属 View 内唯一，禁用点号。使用 `formatRef(label, id, refType)` 或 hooks 返回的格式化函数按字面量显示 label。页面内的 `[Selected](Data:selected)` 位于 `item_a` 时，调用显式 Ref 参数传 `item_a.selected`。数组元素 `item_a.items[0]` 的局部名为 `items[0]`。空数组仍有整体 Ref。普通文本继续按字面值传递。

Tool 声明使用 TypeBox。普通字段和解析后的 Ref 允许有限 JSON 数据，包括 null、整数、混合数组和嵌套对象。Ref 可选 `schema` 校验源数据，`refParam` 则校验调用时选中的实际值。相同的源 Ref 可以用于不同目标约束。可选字段省略后仍缺失，`default` 作为 schema 注释保留。

本地校验支持对象属性、必填字段、布尔 `additionalProperties`、数组 `items`、`enum`、`const`、字段及 Ref 值的 `anyOf`、字符串长度与 Unicode `pattern`、数值上下限、数组长度、`description` 和 `default`。`Type.Unknown()` 与 `Type.Any()` 仍受普通 JSON 捕获限制。显式 Ref 可作直接参数，也可作直接数组参数的元素。复杂引用、tuple、codec 和未列出的约束在声明时报告代码和 schema 路径。

Tool handler 返回收据，业务状态通过下一次 View 发布呈现。普通 TS 的 `publish` 同步校验候选帧。失败异常包含 code、path 和原因。最近有效快照、已提交的 View 和 Tool 身份保留，App 暂停新调用直到提交有效帧。原样提交可恢复原有身份和调用资格，成功关闭后再打开会分配新身份。已产生业务副作用的操作由 App 记录真实结果，恢复时只补交投影。

使用 `registerCleanup({ stop, close })` 或 Preact 的 `useAppLifecycle` 登记 App 自有资源。异步准备结束后检查 `signal.aborted`。关闭时已经开始的初始化与资源登记由 Runtime 收尾。

## Manifest 和 Host

例如把普通 TS 入口编译为 `dist/work-items-plain.js`，在 App 的 `package.json` 中设置 `"type": "module"`、`"main": "./dist/work-items-plain.js"` 和版本。Preact 使用它对应的输出文件。仓库内可以执行 `node scripts/generate-aoapp.mjs <app-dir>` 生成 `aoapp.json`。仓库外分发同样形状的静态文件，并保持 `app_name` 与默认导出的 factory 一致。

```json
{
  "app_name": "work_items",
  "version": "0.1.0",
  "toolAuthoringProtocol": "view-type-tools-v4",
  "persistenceSupport": "state-session-v1",
  "appLifecycleSupport": "app-lifecycle-v2",
  "entry": { "main": "./dist/work-items-plain.js" }
}
```

Host 通过公开 Runtime 与 Agent Driver adapter 注册、安装和观察。以下 Node.js 脚本调用已采用观察中的 Ref。创建另一实例会启动独立的 Worker。

```js
import { AppRegistry, createRuntime, createDesktopId } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

const runtime = createRuntime();
const registry = new AppRegistry();
try {
    await registry.registerTransient('local:/absolute/path/to/work-items');
    const id = await runtime.createDesktop(createDesktopId('demo'));
    const desktop = runtime.getDesktop(id);
    for (const result of await registry.installAll(desktop)) {
        if (result.status === 'failed') console.error(result.name, result.issue);
    }
    const source = new SemanticAOTUIDrivenSource(desktop, runtime);
    try {
        const context = await source.getContext();
        try {
            await context.adopt?.();
            const result = await context.executeTool?.('work_items-Item-inspect', { selected: 'item_a.selected' }, 'inspect-1');
            if (!result) throw new Error('No receipt for the current observation');
            if (result.error) throw new Error(result.error.message);
        } finally {
            await context.release?.();
        }
        const next = await source.getContext();
        try {
            await next.adopt?.();
            console.log(next.messages);
        } finally {
            await next.release?.();
        }
    } finally {
        await source.dispose();
    }
} finally {
    const report = await runtime.beginShutdown().completion;
    if (!report.resourcesReleased || !report.ok) console.error(report);
}
```

`TOOL_INVALID_ARGS` 指向原始参数路径，`REF_VALUE_UNSUPPORTED` 指向解引用后不符合目标 schema 的值。直接调用 `desktop.installDynamicWorkerApp` 或 `runtime.installDynamicWorkerApp` 时，拒绝异常的 cause 链保留开发者诊断。`AppRegistry.installAll` 返回逐 App 的 installed、registered 或 failed。成功项携带 ID，失败项携带阶段与诊断，其他 App 继续安装。已运行 App 的投影校验失败会在公开观察和 Agent Driver 诊断中带出有界的 code、message 和 path。

线路 schema 保留业务约束，Ref 在模型侧表现为地址字符串。具体 provider strict 模式的能力由 Host/provider 适配负责。

## 迁移

现有 Preact App 仍使用 `createTUIApp({ component, ... })`。使用 SPI 的自定义 factory 从 `initializeComponent(container, context)` 迁移到 `initialize(context)`，返回带 `close()` 的实例。旧 `ComponentFactory`、`ComponentRenderer` 及 `kernelConfig.component` 退出，SDK 和 Runtime 需要配套重建。同版本且采用本批静态声明格式的 SDK 构建副本可以互用 Tool / ToolSet，注册的 handler 与 View 实例仍由各自 Worker 持有。
