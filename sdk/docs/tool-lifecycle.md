# 普通 Tool 与应用清理

`useViewTypeTool` 是唯一 View-local Tool 声明路径。只读普通参数显式设置 `isMutating: false`；只读 Ref 也用同一 Hook，并走 snapshot-value-v2。普通写操作不需要声明实体 Ref 或使用专用实体 Hook。应用负责业务版本、并发检查和真正完成后才返回成功；SDK 负责把调用交给正确的已提交 Handler，Runtime 负责实例、View、绑定、参数、授权与自身生命周期。

## 普通异步 Tool

在目标 View 内使用现有的三参重载，可选第四参控制 enabled：

```tsx
useViewTypeTool('save', {
  description: 'Save the current document after edits are ready.',
  params: { filePath: { type: 'string', required: true }, content: { type: 'string', required: true } },
  target: { param: 'filePath', value: document.path },
  isMutating: true,
}, async ({ content }) => {
  await document.save(content); // 应用等待真实写入并检查自己的业务条件。
  return { success: true, data: { message: 'Saved. Read the updated FileDetail View.' } };
}, { enabled: document.ready });
```

`document` 是应用提供的对象，SDK 不创建或验证其业务协议。普通参数复用既有 B1 捕获/校验规则：不转换类型，不填默认值，默认拒绝额外字段；`additionalProperties: true` 可显式允许额外 JSON 字段。参数和 Handler 在提交时绑定。enabled 位于可选第四参，而不是 options 中。

工具注册与工具目录的呈现分开：上述 Hook 仍在目标 View 内调用，但不需要渲染它返回的 UI 组件。Root 的 `Application Instruction → Views → <View Type> → Available Tools` 按类型列出一次静态目录；实例 View 只呈现当前业务数据、目标值与状态。目录不随实例打开、关闭或 enabled 变化，也不授予调用能力。当前上下文附带的 Tools 才是当下可调用的工具，关闭实例仍撤销它的执行绑定。

所有普通参数调用（含空参数只读工具）使用 `ordinary-v2`；单个必填顶层只读 Ref 与普通参数组合使用 `snapshot-value-v2`。不支持 V2 时明确拒绝，不降级到旧通道。旧 ViewType+ToolName type-wide Hook 签名和专用只读 Hook 已删除；Tool 声明属于当前 View 实例。普通调用不需要顶层 `refId`、`entityType/entityId/entityVersion` 或额外的 `{result: ...}` 包装。

| Handler 返回值 | 含义 |
| --- | --- |
| `{ success: true, data }` | 应用报告操作成功，实际完成时机由应用保证。 |
| `{ success: false, error, effects: 'none' }` | 应用声明失败且没有业务副作用。 |
| `{ success: false, error, data, effects: 'partial' }` | 应用声明失败但已经有部分效果，可用 data 说明已完成项目。 |
| `{ success: false, error, data }` | 未声明副作用；Core 保留原结果并按已有规则报告 unknown。 |
| 抛异常、非法结果、响应丢失 | 不推断没有副作用，不自动重新执行。 |

`effects` 在 ordinary-v2 的失败结果中生效；SDK 将它转交给现有终态字段，不把声明当成框架验证。常规成功只需一个 `OperationResult`。业务上需要“必须基于版本 N 修改”的应用可自行提供 expectedVersion 参数并校验；普通框架不强制所有应用采用该模型。

当前普通模式保持 App/View/Tool 绑定检查，但同一绑定的业务状态变化不会自动撤销旧 Observation。IDE 的文件和工作区并发守卫继续由 IDE 实现，显示面板变化不再充当语言查询的业务版本。

## 同类型的多个 View

对外 Tool 名称是 `appName-ViewType-toolName`。多个 FileDetail 实例只暴露一个相同名称和 Schema 的 Tool；打开第二个文件不会新增参数、加摘要后缀或复制工具。

应用在参数声明中保留业务目标（例如 `filePath`），再用 `target: { param: 'filePath', value: document.path }` 说明本 View 对应的值。这个字段是注册元数据，不会成为新的模型参数。该版本选择普通 string 参数，不能将需要解析为对象的 Ref 参数用作 selector；Ref 仍按其独立合同解析。`param` 必须指向现有的必填普通 string 参数，各实例使用相同参数名、不同参数值；公开 Schema 仍完全来自 params。只读普通参数同样支持这个选项。

Runtime 捕获本轮观察中的对应关系，执行时验证参数与绑定一致。关闭、重开、目标值改变或重新注册后，旧绑定不能被重新指向新对象。内容更新本身不会撤销仍然有效的绑定。目标值必须在 View 中明确可见，不能让 Agent 猜测。

单实例工具可不声明 target；同一工具出现多个实例却没有声明目标时，标准 Agent Source 报 `TOOL_TARGET_REQUIRED`，不会选第一个实例或临时注入 `aotui_view_id`。多个实例声明重复目标值或不同参数名会报 `TOOL_TARGET_CONFLICT`。这是适配层的调用入口要求，不改变 Core 的显式 bindingId 调用能力。

该声明需要 Runtime 端口的 `targetSelectorSupport: 'argument-v1'`。旧端口明确报 `TOOL_TARGET_UNSUPPORTED`，不会静默忽略。Core 不识别 filePath、Terminal 等业务名；应用负责声明值、业务授权和资源检查。多个实例应由标准目标选择或直接持有 Scope 的集成方显式选 Binding，不能假定入口会猜测目标。

原生 Tool 名称在 SDK → Runtime 注册时检查：完整名称只允许英文字母、数字、下划线和连字符，总长不超过 64；非法名称报 `AOTUI_TOOL_NAME_INVALID`，不截断、不散列、不自动改名。Core 内部身份不受这个模型适配约束影响。

## 模型侧的操作反馈

普通异步 Handler 必须等待所定义的操作完成。成功返回的 data 由标准 Source 直接作为 Tool Result 交给模型；无 data 时返回 `{ success: true }`。失败保留业务 code、message 和必要恢复信息。`receipt`、`executionPhase`、`outcomeStatus` 不再作为额外包装进入模型上下文。

业务正文和查询集合由 View 呈现，data 可包含操作说明、影响数量、目标 View 标识及恢复信息。SDK 不自动猜测或剥离业务数据，应用作者负责遵守这一边界。如果写入只完成了一部分或无法确认效果，模型会收到明确错误和检查当前状态的提示；不会把无法确认包装成成功，也不会自动重试。

Core 的 accepted 能力保留给显式异步集成；它不是普通模型工具的正常终态。标准 Source 遇到 accepted 会报告 `TOOL_RESULT_NOT_FINAL`，说明未得到完成确认，而不声称业务没有执行。后台任务可以把“成功启动任务”定义为本次 Tool 的完整操作，最终任务状态继续由 View 表达。

## 可选清理回调

```tsx
useAppLifecycle({
  stop() { session.stop(); },
  close() { return session.close(); },
});
```

`stop` 与 `close` 各自可选；无回调的应用正常关闭。stop 同步停止应用的新工作；close 可等待应用实际拥有的文件、监听和子进程。已接受的初始化会先汇合；卸载不会丢掉 cleanup 责任。

该 Hook 需要 App 上下文，每个 App 实例至多登记一次。登记它的组件卸载时会启动已登记的 stop/close。建议放在根组件或其他与 App 同寿命的组件中，避免随单个 View 反复挂载。

报告只含 `protocol / instanceId / state / issues`，协议为 `app-lifecycle-v2`。它描述回调完成情况；Runtime 的 `resourcesReleased` 描述 Runtime 实际掌握的资源。失败回调仍被记录，执行器不健康回池；即使随后 Worker 与存储确实释放，关闭也不会被包装成成功。外部进程由创建它的应用清理。

## 迁移与兼容

删除了 `useEntityRef` 和旧 entity File mutation authoring。应用自行维护实体 ID、版本与条件写入；通用普通 Tool 仍可发布普通数据 Ref，但 Ref 不自动授权资源修改。IDE 默认入口直接使用 scoped IDE。

使用同一交付的 Runtime、SDK、IDE tarball。版本号相同不代表历史产物支持新合同：旧 Worker 不会因 SDK 声明而获得 V2 能力。`createTUIApp` 默认且始终声明 `app-lifecycle-v2`，Runtime 缺少匹配确认时拒绝初始化；应用无需设置生命周期 opt-in，回调本身仍可省略。当前 Runtime 只接受 `module.default` 中的托管组件工厂；旧 manifest/create、callable 与对象 App fallback 均已退出，不自动补授权或降级重试。
