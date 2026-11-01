# 按能力迁移 SDK 调用

普通读写、只读参数与单对象 Ref 都使用 `useViewTypeTool(name, options, handler, config?)`；只读工具显式设置 `isMutating: false`。实体 File 条件写入由应用自行维护。`createTUIApp` 默认协商正式 app-lifecycle-v2；需要清理外部资源的应用在长寿命组件中调用 `useAppLifecycle`，stop/close 回调各自可选。需要匹配产物；旧 wrapper 不自动升级。完整合同与 IDE 迁移见 [普通 Tool 与应用清理](tool-lifecycle.md) 和 IDE 的 SCOPED_IDE.md。

以下完整应用对照历史 D5 SDK 的参数路径与新合同。迁移前示例只用于展示旧产物；旧 `defineParams` 不属于当前 SDK 根入口。迁移后的代码直接把参数对象传给 `useViewTypeTool`。旧 ViewType+ToolName 的 type-wide Hook 签名和 `typeTools` Context 已退出，不存在兼容重载。

## 迁移前：历史 D5 SDK 参数路径

```tsx
import { h } from 'preact';
import { createTUIApp, View, useState, defineParams, useViewTypeTool } from '@aotui/sdk';

function SummaryContent() {
    const [last, setLast] = useState('No result');
    useViewTypeTool('inspect', {
        description: 'When to use: inspect the displayed summary. How to use: supply choice and a short text.',
        isMutating: false,
        params: defineParams({
            choice: { type: 'enum', options: ['7', 'ok'], required: true },
            text: { type: 'string', required: true, constraints: { maxLength: 1 } },
            limit: { type: 'number', default: 2 },
        }),
    }, async (args) => {
        setLast(JSON.stringify({ choice: args.choice, text: args.text }));
        return { success: true, data: { view_id: 'summary', choice: args.choice, text: args.text,
            has_extra: Object.hasOwn(args, 'extra'), has_limit: Object.hasOwn(args, 'limit') } };
    });
    return <p>{last}</p>;
}

function AppRoot() {
    return <>
        <View id="root" type="Root" name="Root">
            <h1>Summary Application Instruction</h1>
            <h2>What Summary is</h2><p>Inspect the current summary.</p>
            <h2>How to use Summary</h2><p>Call inspect and read the summary View.</p>
            <h2>Views of Summary</h2><h3>Summary</h3>
            <h4>Summary Instruction</h4><p>Shows the last inspection result.</p>
            <h4>Summary Available Tools</h4><ul><li>inspect</li></ul>
        </View>
        <View id="summary" type="Summary" name="Summary"><SummaryContent /></View>
    </>;
}

export default createTUIApp({ app_name: 'summary_legacy', component: AppRoot });
```

## 迁移后：通过 View-local Hook 声明普通只读参数

```tsx
import { h } from 'preact';
import { createTUIApp, View, useState, useViewTypeTool } from '@aotui/sdk';

function SummaryContent() {
    const [last, setLast] = useState('No result');
    useViewTypeTool('inspect', {
        description: 'When to use: inspect the displayed summary. How to use: supply a declared choice and one Unicode code point.',
        isMutating: false,
        params: {
            choice: { type: 'enum', options: ['7', 'ok'], required: true },
            text: { type: 'string', required: true, constraints: { maxLength: 1 } },
            limit: { type: 'number', default: 2 },
        },
}, (args) => {
        setLast(JSON.stringify({ choice: args.choice, text: args.text }));
        return { success: true, data: { view_id: 'summary', choice: args.choice, text: args.text,
            has_extra: Object.hasOwn(args, 'extra'), has_limit: Object.hasOwn(args, 'limit') } };
    });
    return <p>{last}</p>;
}

function AppRoot() {
    return <>
        <View id="root" type="Root" name="Root">
            <h1>Summary Application Instruction</h1>
            <h2>What Summary is</h2><p>Inspect the current summary.</p>
            <h2>How to use Summary</h2><p>Call inspect and read the summary View.</p>
            <h2>Views of Summary</h2><h3>Summary</h3>
            <h4>Summary Instruction</h4><p>Shows the last inspection result.</p>
            <h4>Summary Available Tools</h4><ul><li>inspect</li></ul>
        </View>
        <View id="summary" type="Summary" name="Summary"><SummaryContent /></View>
    </>;
}

export default createTUIApp({ app_name: 'summary_contract', component: AppRoot });
```

## 已知行为变化

| 输入 | 旧普通参数路径 | 新合同 |
|---|---|---|
| `{ choice: 'ok', text: 'a' }` | 正常执行 | 正常执行 |
| choice=7，options 含字符串 '7' | enum 比较字符串形式，handler 仍收到原值 | 严格比较，拒绝数字，不做转换 |
| text='😀'，maxLength=1 | 旧 UTF-16 长度判断拒绝 | 一个 Unicode code point，允许 |
| 附加 extra | 保留额外字段 | 默认闭合，拒绝；开放需要声明 additionalProperties |
| 缺席 limit，声明 default=2 | 不自动填充 | 不自动填充 |

TypeScript 会提前阻止一部分错误 JS 输入，运行时仍需验证模型/JSON 调用。旧宽 `ParamDef`/`defineParams` 属于历史 API，当前 SDK 已移除该 helper。新普通规则只来自 Runtime B1，Ref 组合来自 B3B，SDK 不复制规则。

## Ref V2 的条件

单对象快照 Ref 完整应用见 [readonly-ref-v2](readonly-ref-v2.md)。它需要单个必填顶层 reference、`refSource: 'snapshot-value-v1'` provenance marker、同 View owner、`isMutating: false` 和匹配的 Runtime/Worker snapshot-value-v2 能力。该 marker 描述来源语义，不是旧 V1 transport。Core 来源模式、声明 profile、Wire mode 是不同职责；应用继续只写参数和 handler。无业务 refType 时保留真实 unknown，具体声明严格比较。Host 用 `interactionModes` 配置可用模式；省略时支持 ordinary-v2 与 snapshot-value-v2，执行仍须经过受信授权。

文件创建与覆盖策略由应用自己的资源 adapter 实现。`useViewTypeTool` 仍通过 ordinary-v2 返回应用的 `OperationResult`：明确的 `effects: 'none' | 'partial'` 保留在终态；未声明副作用的失败继续表示 unknown，不会被 SDK 改写为“无副作用”。只读是行为声明，不能替代权限或来源检查。

## 结果、环境与弃用项

handler 返回应用的 `OperationResult`；Controller 另有来源、执行阶段、可见性和回执。可信 entered-returned 中的业务结果可以映射为 unknown，同时传输仍健康。不能用结果字符串判断 Worker 是否可复用；依据适用的 Runtime 能力合同和终态判断 Worker 是否可复用。

`useAppEnv` 已删除；迁移为 `useAppRuntimeContext().launchConfig`，并按应用配置字段检查类型。该 Hook 只能在 Runtime 托管的 App Context 中调用；缺少 Context 时会抛错。SDK 根入口仍导出 `OperationResult` 与 `OperationError`，并直接复用 Runtime SPI 类型定义。

旧 ViewType+ToolName Hook 调用不再有运行时兼容路径。将 Tool 声明放到目标 `<View>` 的子组件内，使用 `useViewTypeTool(name, options, handler, config?)`；每个已挂载实例拥有自己的 binding，跨实例调用仍需来源提供的目标选择与执行时授权。组件通过状态决定是否渲染 `<View>`，以挂载和卸载控制页面生命周期。`useLLMOutputChannel` 只接收实时输出 listener，并监听 Worker 派发的 `aotui:llm-text` 事件；事件桥不提供历史，SDK 不公开历史读取 Hook，也不承诺宿主提供历史 Provider。

使用 `app_name` 字符串替代旧示例误写的 name。应用模块的 `default` 必须是唯一托管组件工厂；Runtime 通过 `initializeComponent` 初始化组件树。`createTUIApp` 总是声明 `app-lifecycle-v2`，清理 callbacks 可选，不再设置实验 opt-in。旧 `factory.create()`、callable factory 与 manifest/create 双模式已退出。

C01 的 Breaking Changes：

- 删除 `persistenceManager` 及其全局注册/保存类型。通常使用 `usePersistentState` 声明实例状态；需自行管理绑定与恢复的高级应用可用 `useAppRuntimeContext().persistence` 的 `AppStatePersistence` 端口，并检查 `flush()` 报告。
- 删除 `useMountableViewRegistry/useDynamicViewRegistry`、对应类型以及组件 Context 中仅抛错的字段。通过组件状态挂载或卸载 `<View>`。
- 删除 `useResourceRef` 过渡别名，数据引用统一使用 `useDataRef/useArrayRef`。根 `useRef` 仍是 Preact Hook。
- 删除 `useSignalStore` 及其 `SignalStore` 类型，组件状态使用现有 `useState/useReducer`。
- 删除根入口的 `assertValidOperationName/validateAppId/validateViewId/validateOperationName/validateFunctionName`。View 与 Runtime 必需的身份、输入和来源校验仍由各自正式契约执行。

本轮另已删除 type-wide Tool 注册、IView/ViewFactory、InlineView 和旧 Factory 双模式。当前唯一 Tool Hook 使用 ordinary-v2 或 snapshot-value-v2；Host 以 `interactionModes` 限定可用集合，并通过 `createAppScope` 执行目标选择与受信授权。生命周期合同由 SDK 工厂默认声明。

完整名称和条件见 [API 状态](api-status.md)，入口见 [SDK README](../README.md)。独立分发、关闭排空/flush、产品延迟/RSS和整体稳定承诺未由这一迁移授予。
