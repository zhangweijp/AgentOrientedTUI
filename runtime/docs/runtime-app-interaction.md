# Runtime App 公共交互

可信 Host 安装 App 并选择唯一当前执行 mode `view-type-parameters-v1`。所有 Tool 都是 App + ViewType 注册：普通值直接作为参数，Ref/ArrayRef 用 `refParam` 在同一合同中声明。一次观察固定 View、Ref 来源、类型 activation 与 Binding；当前数据通过 View，调用返回短收据。

普通 App 作者从 [SDK 指南](../../sdk/README.md) 和完整文件／Ref 示例开始。本文面向安装 App、选择授权与管理资源的可信 Host；App 不承担这些装配职责。

## 应用声明

下面保留一个普通路径编辑工具与一个 Ref 检查工具。文件打开/编辑继续使用有业务意义的普通 filePath；Ref 工具只演示从已展示快照中取数据，不是文件打开/编辑的必需入口。对已展示的 File 对象，模型传入所属 `view_id.ref_id`，不携带展示类型前缀，不再另抄内部业务 ID。Ref 数据冻结不限制 App 执行自己的业务变更。应用自己校验是否打开、版本/权限和父子归属。

<!-- b2-app:start -->
```js
import { h } from 'preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { AppTools, ToolCatalog, createTUIApp, defineToolSet, defineViewTypeTool,
  refParam, View, useDataRef } from '@aotui/sdk';

const FileSchema = Type.Object({ filePath: Type.String(), text: Type.String() }, { additionalProperties: false });
const tools = defineToolSet({
  ordinary: defineViewTypeTool({ viewType: 'Detail', name: 'ordinary',
    description: 'Apply text to an open file path; read the updated Detail.',
    inputSchema: Type.Object({ filePath: Type.String(), text: Type.String() }, { additionalProperties: false }) }),
  ref: defineViewTypeTool({ viewType: 'Detail', name: 'ref',
    description: 'Inspect the displayed File Ref.',
    inputSchema: Type.Object({ file: refParam('File', FileSchema) }, { additionalProperties: false }) }),
});
function Detail({ count, text }) {
  const file = useDataRef('file', { filePath: '/open/note.txt', text }, { refType: 'File' });
  return h('section', {}, h('p', {}, 'Open file: /open/note.txt'), h('p', {}, file('Current file value')), h('pre', {}, text),
    h('p', {}, `Completed actions: ${count}`));
}
function Root() {
  const [count, setCount] = useState(0), [text, setText] = useState('original');
  return h(AppTools, { definition: tools, bindings: {
    ordinary: { execute: async args => {
      if (args.filePath !== '/open/note.txt') return { success: false, effects: 'none',
        error: { code: 'VIEW_NOT_OPEN', message: 'This Detail is not open.' } };
      setText(args.text); setCount(current => current + 1);
      return { success: true, data: { message: 'Change completed.' } };
    } },
    ref: { execute: async args => {
      if (args.file.filePath !== '/open/note.txt') return { success: false, effects: 'none',
        error: { code: 'VIEW_NOT_OPEN', message: 'Refresh the current File Ref.' } };
      return { success: true, data: { currentValueAvailable: true } };
    } },
  } }, [
    h(View, {kind: 'instruction', id: 'root', type: 'Root' }, h('section', {},
      h('h1', {}, 'File Application Instruction'),
      h('p', {}, 'Use a meaningful file path for editing, or the containing View id plus the local File Ref for inspection (detail.file). Read Detail for data.'),
      h(ToolCatalog, { definition: tools }))),
    h(View, {kind: 'state', id: 'detail', type: 'Detail' }, h(Detail, { count, text })),
  ]);
}
export default createTUIApp({ app_name: 'interaction_example', component: Root });
```
<!-- b2-app:end -->

SDK 工厂自动提供 `view-type-tools-v4`、托管状态和 `app-lifecycle-v2` 标记；不需 App 手写协议或生命周期开关。有自有资源才使用 useAppLifecycle。

低层 SDK 适配器使用 managed factory 的 `AppInstance` 和 Ref 注册接口 `IRefRegistry`。`IAOTUIApp` 和 `IViewMeta` 已退出 Runtime SPI。

## Host installation and instance interaction

The trusted Host selects an interaction mode at install. Omitting `interactionModes` enables execution. Passing `[]` keeps observation and preview available and disables Tool execution. Use the matched Runtime and SDK packages.

Construct the Runtime with `createRuntime()`. The returned `IKernel` includes App interaction and shutdown reporting. Use `getDesktop()` for the `IDesktop` contract. These interfaces replace imports of the concrete `Kernel`, `IDesktopManager`, and the separate access and shutdown reporting interfaces.

The Worker handshake requires `app-snapshot/v3`. The Host also requests `view-tool-parameters-invoke/v4` when execution is enabled. A malformed capability list receives `WORKER_CAPABILITY_INVALID`. Retired and unknown capabilities receive `WORKER_CAPABILITY_UNSUPPORTED`. Current Tool calls use `VIEW_TOOL_INVOKE_V4` and are correlated with the matching V4 terminal. V2/V3 invocation messages and the separate `REQUEST_UPDATE` push have retired. Snapshot publications notify the Host. The `ordinary-v2` identifier in the trusted invoker contract remains the invoker ABI.

<!-- b2-example:start -->
```ts
import { createRuntime, type InteractionMode } from '@aotui/runtime';
import type { AppInteraction, Observation } from '@aotui/runtime/core';

export async function runExample(appUrl: string, dataDirectory: string) {
  const runtime = createRuntime({ worker: { timeoutMs: 4000, maxWorkers: 2 } });
  try {
    const desktopId = await runtime.createDesktop();
    const desktop = runtime.getDesktop(desktopId);
    const modes: InteractionMode[] = ['view-type-parameters-v1'];
    async function observeReady(client: AppInteraction): Promise<Observation> {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        let notify!: () => void;
        const changed = new Promise<void>(resolve => { notify = resolve; });
        desktop.output.subscribe(notify);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await client.observe({ viewIds: ['detail'] });
          if (result.status === 'observed') return result.observation;
          if (result.issue.code === 'APP_INTERACTION_UNAVAILABLE') throw Error(result.issue.code);
          await Promise.race([changed, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('Snapshot readiness deadline')), Math.max(1, deadline - Date.now()));
          })]);
        } finally {
          desktop.output.unsubscribe(notify);
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      throw Error('Snapshot readiness deadline');
    }
    const appId = await runtime.installDynamicWorkerApp(desktopId, appUrl, {
      interactionModes: modes, config: { AOTUI_DATA_DIR: dataDirectory },
    });
    const instanceId = desktop.getInstalledApps().find(app => app.appId === appId)?.appInstanceId;
    if (!instanceId) throw Error('App has no running instance');
    const access = runtime.getAppInteraction(desktopId, appId, instanceId);
    if (access.status !== 'ready') throw Error(access.issue.code);
    const client = access.interaction;
    const outcomes = [];
    const observation = await observeReady(client);
    try {
      const adopted = client.adoptObservation(observation.observationId);
      if (adopted.status !== 'adopted') throw Error(adopted.status);
      const requests = [
        { name: 'ordinary', input: { filePath: '/open/note.txt', text: 'change' } },
        { name: 'ref', input: { file: 'detail.file' } },
      ];
      for (const [index, request] of requests.entries()) {
        const tool = observation.tools.find(tool => tool.name === request.name);
        const binding = observation.bindings.find(binding => binding.toolId === tool?.id);
        if (!binding) throw Error('Tool binding unavailable');
        const result = await client.invoke({ invocationId: `example-${index}`, observationId: observation.observationId,
          bindingId: binding.bindingId, input: request.input });
        if (result.kind !== 'receipt') throw Error(result.code);
        if (result.receipt.outcome.status !== 'succeeded') throw Error(result.receipt.outcome.status);
        outcomes.push(result.receipt.outcome);
      }
    } finally {
      client.releaseObservation(observation.observationId);
    }
    const close = await runtime.beginShutdown().completion;
    if (!close.ok || !close.resourcesReleased) throw Error('Runtime shutdown did not complete successfully');
    return { modes, outcomes, close };
  } finally {
    const close = await runtime.beginShutdown().completion;
    if (!close.resourcesReleased) throw Error('Runtime resource release is incomplete');
  }
}
```
<!-- b2-example:end -->

The readiness wait subscribes before observing and unsubscribes in finally; it waits for a publication signal rather than guessing with a fixed sleep. The deadline is an error boundary, not evidence that any business work ended. The Host obtains the running instance by App ID and expected execution instance ID. Reopening starts a new Worker and requires a new handle.

The granted views determine the visible Ref owners and matching type Tools. They do not bind a shared Tool to one file. The framework resolves Ref parameters only from the original granted Observation, validates their metadata type/Schema and rechecks source and activation. A plain path is still checked by the App; a resolved Ref's internal identity is also checked against current business state. A same-type View can keep the shared Tool active after another closes. An explicit Ref to the original closed View fails with `REF_VIEW_UNAVAILABLE` and its parameter path. Host authorization remains independent. The example uses the default policy for a trusted Host. Pass a fixed `AppInteractionPolicy` when the Host needs narrower projection, execution, or receipt access.

Both example calls use one Observation: the Ref remains its original frozen value after the edit. The current View contains the updated business text. Receipts do not repeat either text. Observe prepares one candidate alongside the current observation. Adoption revokes the previous calling eligibility and releases its source. Use preview() for read-only rendering without reserving a candidate.

Call IDs are deduplicated for the adopted observation and its retained history. Read a settled or late receipt with readReceipt(request, timeoutMs), using the original observation ID, binding ID, call ID and arguments. Each read uses the original instance policy. Callers can time out while execution remains active. The standard Source does not expose receipt polling or generic task queries. Unknown writes are not retried. Source is provided separately by `@aotui/agent-driver-adapter`; Context/release and Runtime shutdown are described in [Semantic Host integration](semantic-host-integration.zh-CN.md) and [shutdown](runtime-shutdown.md).

模块初始化或首次渲染失败时，宿主可检查本地 cause 链；见 [INIT / OPEN 诊断说明](initialization-diagnostics.md)。这些开发诊断不会自动进入 ToolResult 或 View。

Host 可以用 `client.invoke(request, timeoutMs)` 为一次等待指定期限。已派发调用在等待截止时可返回 unknown，原执行在 Worker 内继续受 Runtime 跟踪。使用相同调用 ID 和原请求可以读取晚到收据。采用新观察后发起新调用须使用新的 Observation 及其绑定。关闭及存储释放合同见 [Worker 与 App 资源归属](worker-lifecycle.md)。

## 身份与元数据来源

`createApp` 与 `createTUIApp` 的 app_name、whatItIs、whenToUse 只在工厂声明中写一次。现有构建脚本从工厂及 package.json 的版本、入口等分发字段生成 aoapp.json。Registry 读取这个静态文件，不 import App 来发现名称或说明；缺失／损坏生成物拒绝为 APP_MANIFEST_INVALID，不猜 package.json main 或 index.js。注册 key 必须与生成的 app_name 相同，配置中的 alias/说明覆盖退出。Worker 在调用 `initialize(context)` 前核对 INIT.appName 与工厂 kernelConfig.appName，不用展示标签代替逻辑名称。

| 对象 | 生成方与唯一范围 | 生命周期与执行用途 |
| --- | --- | --- |
| app_name | 作者；生成清单和 Registry 中唯一 | 逻辑应用名称可在重新安装时复用；标准 Source 的工具前缀；不是某次运行的权限或 ID |
| App ID | Runtime/AppManager；Desktop 内唯一 | 安装对象身份，跨关闭／重开可保留；调用必须再匹配本次 instanceId |
| App instanceId | Runtime；每次逻辑执行新建 | 旧 Context 不得命中同 App ID 的继任执行；每次使用全新 Worker |
| View id/type/name | 作者；id 在 App 的当前挂载集合内唯一 | id 是逻辑页面，type 激活共享工具，name 是呈现标签；不能互相猜测或作为运行实例身份 |
| View instanceId | Runtime；每次挂载新建 | 同 id 重挂不恢复旧 Ref 资格；Core 的 owner 与实例来源检查使用它 |
| Tool name 与内部 id | 作者声明 name，Runtime/Core 生成 `[appId, viewType, name]` 的结构化标识 | 同类型共享一个注册；内部身份不拆解外部工具名。注册／handler 更新与 activation 资格分别维护 |
| 原生 Tool 别名 | Source 按三个字段确定生成 | ASCII 字母/数字/下划线，连字符只作分隔，总长至多64；这是原生入口约束，不是 Core 结构化名字的限制。失败只隔离对应 App，无覆盖、截断或自动别名 |
| Ref 局部名与调用地址 | 作者；同一个 View 内唯一 | 展示保持类型提示；调用为 view_id.local_ref。只有所绑定 Observation 的来源和 View instance 可解析，局部名可在其他 View 复用 |
| Snapshot id/revision | Core；绑定 App 执行实例的已提交版本 | 当前状态只显示最新有效版本；不是业务对象 ID，也不能作为无需再观察的永久资格 |
| Observation id | App instance | 一次准备出的来源集合；显式采用新观察撤销本实例的旧资格并释放旧观察专属数据 |
| Binding/activation id | Runtime/Core；注册和类型活跃期 | handler-only 更新保留注册，禁用／最后 View 关闭后旧资格失效，重新激活产生新身份；Context 捕获执行目标 |
| 状态 appKey | 可信 Host；既有 StateAddress 的 namespace | Registry 默认使用 canonical app_name；Host 可显式传 AOTUI_APP_KEY 选择独立 namespace，不改变注册名、调用目标或 Ref 资格。无通用数据作用域系统 |

AppKernel 从 Runtime AppContext 接收 App ID，不再以逻辑 App 名兜底，也不允许更改已赋予的身份。SDK 的 displayName 和 Kernel.name 是派生呈现／调试标签，不是第二份执行定位来源。旧 AOTUI_APP_NAME 曾混用为持久化 namespace，本次退出；显式需要该能力的 Host 改用 AOTUI_APP_KEY，默认 Registry 生成同样的 namespace 值，不迁移或删除业务持久化数据。

当前常量随拥有合同的 Runtime SPI/Core 导出。工厂／端口使用 view-type-tools-v4，Snapshot 仍为3，工具 IPC 仍为 view-tool-parameters-invoke/v4，生命周期仍为2，持久化会话与记录各自仍为1。INIT 的请求／ACK 必须包含 app-snapshot/v3；启用工具时还必须确认工具能力。不支持的组合在加载／OPEN前明确拒绝，数据的后续严格捕获与来源检查依然独立；没有新 spec 包或通用协商平台。

## 2026-11-09 减法迁移

- `AppContext` 仅携带 `appId`／`desktopId`。SDK 在成功的 Preact 提交中准备 View、Ref 与 Tool，Worker 从缓存发送结果。自定义 Producer 使用 projection 提交边界。
- `IDesktopManager` 直接描述 Kernel 实际使用的服务，不再继承四个未独立使用的接口。Manager 层的 `has` 与安装转发退出；查询使用 `get`，动态安装使用现有 Runtime 或 Desktop 入口。
- 删除未被观察入口消费的 App 日志缓存、`getAppActivityLogs`、`logAppActivity` 和 `logger.maxAppLogs`。App 生命周期事件进入原有有界系统日志，日志额度仍由 `logger.maxSystemLogs` 控制；旧配置明确拒绝。
- 删除 `DataPayload` 转导出，外部事件 payload 仍为 `Record<string, unknown>`；实际 CLI 事件输入与 Worker 事件分发保留。
- 移除 App 注册配置中没有生效的 `version` 声明。CLI 的安装版本来自安装器实际记录的 `distribution.resolvedVersion`，不是第二份手写约束。App package／manifest 版本和配置文件版本继续保留。

这些退出不改变 Tool／Ref／Observation、执行前校验、部分或未知结果、持久化与关闭释放合同。
