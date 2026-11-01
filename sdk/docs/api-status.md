# SDK 根入口与运行合同

本文对应当前 `@aotui/sdk` 根入口的源码 allowlist。包只开放 `@aotui/sdk` 根入口；未列出的 Context、registry、adapter 和 factory assembly 模块不是应用开发 API。类型或值能被导入，不会单独授予 Runtime 执行许可。

## 当前应用开发 API

| API | 用途与限制 |
|---|---|
| `createTUIApp`, `View` | 用 Preact 组件声明应用和 View。应用模块的 `default` 必须是 `createTUIApp(...)` 返回的托管组件工厂。 |
| Preact hooks | `useState`, `useCallback`, `useEffect`, `useMemo`, `useReducer`, `useRef` 从 SDK 重导出，保证组件与 SDK 使用同一个 Preact 实例。 |
| `useViewContext` | 在挂载的 View 内读取公开 View 元数据。 |
| `useAppConfig`, `useAppEnv` | 读取当前应用启动配置和按键访问的环境值。 |
| `useAppRuntimeContext` | 读取 App/desktop 元数据、启动配置和当前实例的 `AppStatePersistence` 客户端口。高级应用可显式绑定、恢复、更新、清理并 flush 自己的实例状态；这里不暴露 Host 的文件系统/storage adapter，也不含 SDK Ref/Tool、投影或生命周期端口。 |
| `useDataRef`, `useArrayRef` | 在 View 中声明当前业务数据的 Ref。发布 Ref 不授予修改或执行权限。 |
| `useViewTypeTool` | 唯一 Tool 声明 Hook；普通参数（包括空参数和只读工具）使用 ordinary-v2。恰好一个必填顶层同 View Ref 时使用只读 snapshot-value-v2。只读声明必须显式写 `isMutating: false`。 |
| `useAppLifecycle` | 可选的应用清理回调 Hook。`createTUIApp` 总是声明 `app-lifecycle-v2`；`stop` 与 `close` 回调各自可选，无需 opt-in 配置。 |
| `usePersistentState` | 声明应用实例状态。setter 更新当前实例会话；Runtime 在关闭时负责 managed flush，Hook 提供恢复状态和显式 `clear()`。 |
| `useLLMOutputChannel`, `useLLMOutputHistory` | 仅使用真实 Provider 或现有 DOM 事件桥；无可用来源时报告固定错误，不伪造历史。 |
| `defineParams` | 兼容型参数声明帮助函数，可保留类型推断；不是 ordinary-v2 或 snapshot-value-v2 的执行授权。 |
| `AOTUIError`, `escapeHtml`, `escapeJsonForAttr` | 公开错误类和静态格式化 helpers。 |

SDK 不导出 Runtime 私有 App/View Context、View registry、Ref registry、Tool registry 或 factory assembler。应用应使用上述 Hooks 和组件；Runtime/Host 集成方直接依赖相应 Runtime 合同。

## View 内容边界

`<View>` 必须作为独立页面声明，不能出现在另一个 `<View>` 的子树内；经普通包装组件返回的嵌套也会被拒绝。SDK 在创建子实例或运行其 Ref/Tool Hook 前抛出 `NESTED_VIEW_UNSUPPORTED`，错误包含 `parentViewId`、`childViewId`，并提示将两个 View 声明为非 View 布局组件下的独立兄弟。普通组件仍可在 View 内任意组合，多个兄弟 View 也合法；需要同时呈现多个 View 时，从应用根组件或 View 外的布局组件返回它们。

## Tool 能力与 Scope

`useViewTypeTool(name, options, handler, config?)` 是唯一的 View-local Tool 声明入口。Hook 把 Tool 绑定到当前已提交的 View 实例；`enabled` 只控制该实例的注册。目标选择元数据、Tool 公共名称和参数语义由当前声明保持，不由应用构造 Binding 身份。

Host 的 `interactionModes` 默认支持 `ordinary-v2` 和 `snapshot-value-v2`。显式列表是完整允许集，`[]` 表示两个执行模式均关闭；缺少任一所需模式时清晰拒绝，不降级到旧调用通道。只读 Hook 声明、Ref ID、Schema 或 Tool 是否可见都不能自行授予执行权限。

可信 Host 使用 Runtime 的 `createAppScope(desktopId, appId, policy)` 建立应用交互 Scope，并在其中完成目标选择、策略授权和调用。Scope 由 Host/Runtime 管理，不由 SDK 应用组件创建。关闭或重建实例后旧 Scope 与 View Binding 必须失效。

Ref V2 的 `refSource: 'snapshot-value-v1'` 只标识声明的来源语义；实际执行模式为 `snapshot-value-v2`。普通 V2 参数约束、Ref 类型推断、target selector 和错误边界见 [ordinary-v2](ordinary-v2.md)、[readonly-ref-v2](readonly-ref-v2.md) 与 [Tool 生命周期](tool-lifecycle.md)。

## 根入口的精确 JavaScript 值

以下名称均为 `@aotui/sdk` 的根 JavaScript 导出：

```text
AOTUIError, View, createTUIApp, defineParams, escapeHtml, escapeJsonForAttr,
useAppConfig, useAppEnv, useAppLifecycle, useAppRuntimeContext, useArrayRef,
useCallback, useDataRef,
useEffect, useLLMOutputChannel, useLLMOutputHistory, useMemo,
usePersistentState, useReducer, useRef, useState, useViewContext,
useViewTypeTool
```

`AOTUIError` 同时可作为 TypeScript 类型引用。

## 根入口的精确 TypeScript 类型

```text
AOTUIError, AppContext, AppID, AppLifecycleCallbacks, AppReinitializeContext,
AppStatePersistence,
ArrayRefHandle, DeepReadonly, DesktopID, IViewMeta,
InferArgs, ItemRefFormatter, LLMOutputEvent,
LLMOutputListener, ListRefFormatter, OperationError, OperationResult,
ParamBaseType, ParamConstraints, ParamDef, ParamSchema, ParamType,
PersistMeta, PersistOptions, PersistStatus, RefHandle,
SnapshotValueRefParamDef, StateBindingStatus, StateFlushReport, StateIssue,
StateValue,
TUIAppConfig, TypeToolArgs, TypeToolHandler, TypeToolOptions,
TypeToolUI, UseViewTypeToolResult, ViewID, ViewProps
```

`OperationResult.effects` 允许应用准确声明失败时无副作用或有部分副作用；省略时 SDK/Core 不推断业务效果。View 与 Tool 推断类型见 [只读 Ref V2](readonly-ref-v2.md)。

## 已退出的 SDK 根入口

`IAOTUIApp` 的对象生命周期合同与 `ILLMOutputChannelContext` 的 Provider 装配接口不属于当前 SDK 根入口。type-wide Tool、旧 View/Factory/registry 组装、专用只读/实体/创建 Hook 也已退出；迁移说明只在标记为历史对照或已删除 API 的段落中引用旧名称。当前 API 的完整迁移见 [migration](migration.md)。
