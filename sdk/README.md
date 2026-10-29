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

`app_name` 是必填字符串，匹配 `/^[a-z0-9_]+$/`；`name` 不能替代它。View ID 在应用内唯一，2–15 位字母、数字或下划线。需要 View 上下文的 Tool/Ref Hook 放在目标 View 的子组件内；App 级 Hook 按各自的上下文要求使用。Runtime 使用 factory 的 `initializeComponent`；应用作者不调用已弃用的 `factory.create()`。

## 添加普通只读工具

使用现有 `experimental_useReadOnlyTool` 声明普通参数，完整示例见 [ordinary-v2](docs/ordinary-v2.md)。规则由 Runtime 统一合同提供：enum 严格比较，Unicode 字符串按 code point 计数，额外字段默认拒绝，`default` 不自动填入缺席参数。开放额外字段须显式声明 `additionalProperties: true`。

入口仍为 experimental。执行要求对应 Runtime 私有包装、准确能力协商和受信 Controller 授权；只读名称或 Schema 声明自身不授予权限。

## 使用原观察快照中的对象 Ref

同一 Hook 可声明一个必填、顶层、同 View owner 的只读对象 Ref；完整示例见 [readonly-ref-v2](docs/readonly-ref-v2.md)。`useDataRef` 发布对象，handler 收到递归只读快照对象；未声明业务 `refType` 时可保留真实的 `unknown`，显式声明时必须匹配。

原观察 A 不因后续 B 发布被替换。历史来源、参数展开、授权后复查和 Worker 身份由框架管理；应用不传 observationId、bindingId 或 Worker ID。数组、多 Ref、跨 View Ref 和任意写操作没有由该入口获得支持。

## 环境与不可用的能力

- 组件模式用状态决定是否渲染 `<View>`，由组件挂载和卸载接入 View 实例生命周期。
- `useLLMOutputChannel` 优先使用宿主实际提供的 Context Provider；没有 Provider 时监听 document 的两个现有事件名。允许在 View 外的 Root 使用；两种来源择一，没有 Provider 和 document 时明确拒绝。
- `useLLMOutputHistory` 只查询实际 Provider。组件 DOM 桥不提供历史，没有 Provider 时不会返回伪造空数组；Provider 自身返回空数组则是合法结果。
- `includeHistory` 已弃用，任何非 undefined 值均拒绝，包括 false。省略时 DOM 只接后续事件，实际 Provider 是否重放由其合同决定；SDK 不新增历史缓存或去重。
- 持久化支持已交付的 managed session；显式存储注入、隔离、关闭排空和 flush 见 [持久化文档](docs/persistence.md)。Legacy 与 managed 确认分别报告，不能相互替代。

## 普通 Tool 与应用清理

普通读写复用 `useViewTypeTool(name, options, handler, config?)` 与 ordinary-v2，无需实体 Ref 或专用结果包装。`experimental_useAppLifecycle` 配合 factory 的 `experimentalAppLifecycle: true` 提供可选的同步 stop 和可等待 close；无回调正常关闭。应用负责业务版本与实际完成，Runtime 负责执行器及自身资源。完整合同见 [普通 Tool 与应用清理](docs/tool-lifecycle.md)。

完整 IDE 的默认入口已使用这些能力，Terminal 和 Browser 也经通用 Semantic Source 接入。默认 Host 通过 AppRegistry 安装应用并协商可执行能力，不要求应用提供专属 DrivenSource。View 的消息与 Tool Binding 在同一次 Context 中捕获；只保留最新 View，操作返回 Receipt。详见 [Semantic Host 接入契约](../runtime/docs/semantic-host-integration.zh-CN.md)。

使用发布物时，必须安装同一交付的 Runtime、SDK、IDE 实际 tarball；相同版本号的历史发布物不因此具备新协议。

完整名称与可用条件见 [API 状态](docs/api-status.md)，分批迁移见 [迁移说明](docs/migration.md)。新语义执行、跨 Host/DOM 可移植性、完整关闭与全部业务迁移尚未获得整体 stable 承诺。

C01 已删除无实际能力的全局持久化入口、组件挂载注册表入口、数据 Ref 过渡别名，以及无消费者的状态便利 Hook 和根命名校验工具。应用使用 `useState/useReducer` 管理组件状态，通过 `usePersistentState` 和当前实例的 `persistence.flush()` 接入保存，使用 `useDataRef/useArrayRef` 声明数据引用；具体 Breaking Changes 见迁移说明。其他实验能力与旧执行路径的状态仍按上述合同说明。
