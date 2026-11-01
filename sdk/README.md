# @aotui/sdk

用 Preact 组件构建面向 Agent 的 TUI 应用。View 呈现数据和使用指引，Tool 提供领域动作，Runtime 管理 View 身份、可见来源与执行。SDK 当前面向已有组件 Runtime，“可 import”不代表所有 Host 或无 DOM 环境均可运行。

## 完整最小应用

```tsx
import { h } from 'preact';
import { createTUIApp, View } from '@aotui/sdk';

function AppRoot() {
    return (
        <View id="root" type="Root" name="Root">
            <h1>Example Application Instruction</h1>
            <h2>What Example is</h2>
            <p>A component application showing its current state as readable text.</p>
            <h2>How to use Example</h2>
            <p>Read this View. This minimal application has no domain tools.</p>
            <h2>Views of Example</h2>
            <h3>Root</h3>
            <p>Root shows application instructions.</p>
        </View>
    );
}

export default createTUIApp({ app_name: 'example', component: AppRoot });
```

`app_name` 是必填字符串，匹配 `/^[a-z0-9_]+$/`；`name` 不能替代它。View ID 在应用内唯一，2–15 位字母、数字或下划线。需要 View 上下文的 Tool/Ref Hook 放在目标 View 的子组件内；App 级 Hook 按各自的上下文要求使用。`createTUIApp` 返回 Runtime 使用的组件工厂；应用模块的 `default` 必须指向唯一托管组件工厂，Host 不会从命名导出中查找工厂。

工具目录放在 Root 的 `Application Instruction → Views → <View Type> → Available Tools`，每个类型列一次，作为静态说明；不要在每个实例 View 中重复渲染。目录可以说明尚未打开的 View 类型和工具，实际调用以当前上下文附带的 Tools 为准。工具的注册仍由所属实例 View 内的 Hook 完成，可以不渲染 Hook 返回的 UI 组件。这样，关闭实例会撤销它的绑定，而静态目录不随实例数量或运行状态改变。

## 添加普通只读工具

普通读写和普通只读 Tool 都使用 `useViewTypeTool`；只读声明显式设置 `isMutating: false`。包括空参数的只读 Tool 在内，所有普通参数都使用 ordinary-v2。规则由 Runtime 统一合同提供：enum 严格比较，Unicode 字符串按 code point 计数，额外字段默认拒绝，`default` 不自动填入缺席参数。开放额外字段须显式声明 `additionalProperties: true`。完整示例见 [ordinary-v2](docs/ordinary-v2.md)。

执行要求对应 Runtime/Worker 能力和受信 Controller 授权；只读名称或 Schema 声明自身不授予权限。

## 使用原观察快照中的对象 Ref

同一 `useViewTypeTool` 可声明一个必填、顶层、同 View owner 的只读对象 Ref，并设置 `isMutating: false`；完整示例见 [readonly-ref-v2](docs/readonly-ref-v2.md)。`useDataRef` 发布对象，handler 收到递归只读快照对象；未声明业务 `refType` 时可保留真实的 `unknown`，显式声明时必须匹配。

原观察 A 不因后续 B 发布被替换。历史来源、参数展开、授权后复查和 Worker 身份由框架管理；应用不传 observationId、bindingId 或 Worker ID。数组、多 Ref、跨 View Ref 和任意写操作没有由该入口获得支持。

## 环境与不可用的能力

- 组件模式用状态决定是否渲染 `<View>`，由组件挂载和卸载接入 View 实例生命周期。
- `useLLMOutputChannel` 在 Worker 中监听 `aotui:llm-text` 事件，可在 View 外的 Root 使用；事件桥仅提供实时事件，没有 document 时明确拒绝。
- 持久化支持已交付的 managed session；显式存储注入、隔离、关闭排空和 flush 见 [持久化文档](docs/persistence.md)。Legacy 与 managed 确认分别报告，不能相互替代。

## 普通 Tool 与应用清理

普通读写、只读 Ref 参数都通过 `useViewTypeTool(name, options, handler, config?)` 声明，分别使用 ordinary-v2 和 snapshot-value-v2。`createTUIApp` 总是声明 `app-lifecycle-v2`，不需要 opt-in；需要清理外部资源的应用可在长寿命组件中调用 `useAppLifecycle`，并按需提供同步 `stop` 或可等待的 `close` 回调。没有外部资源的应用不需要调用该 Hook。应用负责业务版本与实际完成，Runtime 负责执行器及自身资源。完整合同见 [普通 Tool 与应用清理](docs/tool-lifecycle.md)。

可信 Host 从应用模块的 `default` 读取唯一托管工厂，通过 AppRegistry 安装并配置 `interactionModes`。省略该配置时支持 ordinary-v2 与 snapshot-value-v2；显式列表是完整集合，空列表关闭两种执行模式。Host/Runtime 使用 `createAppScope(desktopId, appId, policy)` 为受信应用建立 Scope 并进行目标选择和授权；SDK 组件不创建 Scope，也不能凭 Tool 可见性授予执行权限。详见 [Semantic Host 接入契约](../runtime/docs/semantic-host-integration.zh-CN.md) 与 [SDK API 状态](docs/api-status.md)。

使用发布物时，必须安装同一交付的 Runtime、SDK、IDE 实际 tarball；相同版本号的历史发布物不因此具备新协议。

完整名称与可用条件见 [API 状态](docs/api-status.md)，分批迁移见 [迁移说明](docs/migration.md)。实际执行能力取决于安装的 Runtime/Host 合同；单次 SDK 测试不代表其他运行时或无 DOM 环境已验证。

C01 已删除无实际能力的全局持久化入口、组件挂载注册表入口、数据 Ref 过渡别名，以及无消费者的状态便利 Hook 和根命名校验工具。应用使用 `useState/useReducer` 管理组件状态，通过 `usePersistentState` 声明实例状态；需要定制实例会话的应用也可从 `useAppRuntimeContext().persistence` 使用完整的 `AppStatePersistence` 客户端口，并自行负责绑定、恢复、更新与释放。`useDataRef/useArrayRef` 声明数据引用。上下文只公开 App 元数据、启动配置和实例自有持久化端口；SDK 的 Ref、Tool、投影与生命周期端口保持内部。该端口不是 Host 文件系统适配器。具体 Breaking Changes 见迁移说明与[持久化文档](docs/persistence.md)。
