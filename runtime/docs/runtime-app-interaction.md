# Runtime App 公共交互

可信 Host 安装 App、管理实例并决定工具授权。一次 Observation 采用同一份已提交快照中的全部打开页面、获准解析的 Ref 和动态工具。业务数据通过 View 呈现，Tool 返回操作收据。

应用作者可以从 [SDK 作者指南](../../sdk/docs/app-authoring.md) 开始。

## 应用声明

文件详情页自己持有正文和编辑操作。SDK 根据类型声明生成共享工具定义，Runtime 根据模型传入的 `view_id` 执行该页的 handler。显式 Ref 参数根据原 Observation 解析，可以独立选择数据来源。

下面的示例使用 SDK 的显式 `bindings` 入口，便于看见每页提交的执行绑定。SDK 作者主路径和可运行示例随 `@aotui/sdk` 交付，详见该包 `docs/app-authoring.md`。Runtime 接收的是统一的页面绑定和业务 Schema。

<!-- b2-app:start -->
```js
import { h } from 'preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { ToolCatalog, createTUIApp, defineViewType, refParam, View, useDataRef } from '@aotui/sdk';

const FileSchema = Type.Object({ filePath: Type.String(), text: Type.String() }, { additionalProperties: false });
const Guide = defineViewType({ name: 'Root', tools: {} });
const FileDetail = defineViewType({ name: 'Detail', tools: {
  ordinary: { description: 'Apply text to the selected file. Read the updated Detail.',
    inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }) },
  ref: { description: 'Inspect the displayed File Ref.',
    inputSchema: Type.Object({ file: refParam('File', FileSchema) }, { additionalProperties: false }) },
} });
const viewTypes = [Guide, FileDetail];

function FileBody({ count, text, filePath }) {
  const file = useDataRef('file', { filePath, text }, { refType: 'File' });
  return h('section', {}, h('p', {}, 'Open file: ' + filePath), h('p', {}, file('Current file value')), h('pre', {}, text),
    h('p', {}, 'Completed actions: ' + count));
}
function Detail({ id, filePath }) {
  const [count, setCount] = useState(0), [text, setText] = useState('original');
  return h(View, { kind: 'state', id, type: FileDetail, bindings: {
    ordinary: { execute: async args => {
      setText(args.text); setCount(current => current + 1);
      return { success: true, data: { message: 'Change completed.' } };
    } },
    ref: { execute: async args => {
      if (args.file.filePath !== filePath) return { success: false,
        error: { code: 'REF_WRONG_FILE', message: 'Select the displayed file.' } };
      return { success: true, data: { currentValueAvailable: true } };
    } },
  } }, h(FileBody, { count, text, filePath }));
}
function Root() {
  return h('main', {}, [
    h(View, { kind: 'instruction', id: 'root', type: Guide }, h('section', {},
      h('h1', {}, 'File Application Instruction'),
      h('p', {}, 'Select the receiving View by XML id. For a File Ref, combine its View id and local name (detail.file).'),
      h(ToolCatalog, { viewTypes }))),
    h(Detail, { id: 'detail', filePath: '/open/note.txt' }),
  ]);
}
export default createTUIApp({ app_name: 'interaction_example', viewTypes, component: Root });
```
<!-- b2-app:end -->

SDK 工厂自动提供 `view-type-tools-v5`、托管状态和 `app-lifecycle-v2` 标记。应用可以用 `useAppLifecycle` 管理自己创建的资源。

低层 SDK 适配器通过 managed factory 的 `RuntimeContext` 发布完整页面，Renderer 可用 `mountView` 获取对应的 Ref 所有者。

## Host installation and instance interaction

Tool execution is enabled by default. Install with the trusted Host option `toolsEnabled: false` to keep observation and preview read-only. Installation rejects unknown Host options with `CONFIG_INVALID` and invalid `toolsEnabled` values with `TOOLS_ENABLED_INVALID` before allocation. Use the matched Runtime and SDK packages.

Construct the Runtime with `createRuntime()`. The returned `IKernel` includes App interaction and shutdown reporting. Use `getDesktop()` for the `IDesktop` contract. These interfaces replace imports of the concrete `Kernel`, `IDesktopManager`, and the separate access and shutdown reporting interfaces.

The Worker handshake requires `app-snapshot/v5`. Each published Tool records whether another registered ViewType in the App declares that name. The standard Source uses that fact for its public aliases. When execution is enabled, the Host also requests `view-tool-parameters-invoke/v6`. Incompatible factories or required capabilities fail at load time. The `VIEW_TOOL_INVOKE_V6` request carries the execution descriptor, receiving View ID, mount identity, and activation separately from business arguments. The Worker checks the current receiver before entering its handler.

Both the complete normalized Tool profile and the model schema, including the derived receiver and any eligibility enum, are checked against the inclusive 64 KiB canonical JSON UTF-8 limit. A custom Snapshot Core can set a lower limit. SDK author diagnostics include a Schema path and distinguish invalid, unsupported and over-capacity declarations. [Core limits and declaration diagnostics](core-public-entry.md#snapshot-limits)

<!-- b2-example:start -->
```ts
import { createRuntime, type AppInteraction, type Observation, type ReceiptQuery } from '@aotui/runtime';

export async function runExample(appUrl: string, dataDirectory: string) {
  const runtime = createRuntime({ worker: { timeoutMs: 4000, maxWorkers: 2 } });
  try {
    const desktopId = await runtime.createDesktop();
    const desktop = runtime.getDesktop(desktopId);
    async function observeReady(client: AppInteraction): Promise<Observation> {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        let notify!: () => void;
        const changed = new Promise<void>(resolve => { notify = resolve; });
        desktop.output.subscribe(notify);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await client.observe({ all: true });
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
      config: { AOTUI_DATA_DIR: dataDirectory },
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
        { name: 'ordinary', input: { text: 'change' } },
        { name: 'ref', input: { file: 'detail.file' } },
      ];
      for (const [index, request] of requests.entries()) {
        const tool = observation.tools.find(tool => tool.name === request.name);
        if (!tool) throw Error('Tool unavailable');
        const result = await client.invoke({ invocationId: `example-${index}`, observationId: observation.observationId,
          toolId: tool.id, input: { view_id: 'detail', ...request.input } });
        if (result.kind !== 'receipt') throw Error(result.code);
        if (result.receipt.outcome.status !== 'succeeded') throw Error(result.receipt.outcome.status);
        outcomes.push(result.receipt.outcome);
      }
    } finally {
      client.releaseObservation(observation.observationId);
    }
    const query: ReceiptQuery = { observationId: observation.observationId, invocationId: 'example-0' };
    const original = await client.readReceipt(query);
    if (original.kind !== 'receipt' || original.receipt.outcome.status !== 'succeeded') {
      throw Error('Original receipt unavailable');
    }
    const close = await runtime.beginShutdown().completion;
    if (!close.ok || !close.resourcesReleased) throw Error('Runtime shutdown did not complete successfully');
    return { outcomes, close };
  } finally {
    const close = await runtime.beginShutdown().completion;
    if (!close.resourcesReleased) throw Error('Runtime resource release is incomplete');
  }
}
```
<!-- b2-example:end -->

The readiness wait subscribes before observing and unsubscribes in finally; it waits for a publication signal rather than guessing with a fixed sleep. The deadline is an error boundary, not evidence that any business work ended. The Host obtains the running instance by App ID and expected execution instance ID. Reopening starts a new Worker and requires a new handle.

An Observation always contains the complete committed set of open Views. The Host policy grants Ref identities and Tool IDs. For each Tool, `eligibleViewIds` is present when only a subset of that ViewType can receive the operation. Use the receiving XML View ID in `input.view_id`. For a Ref parameter, use the address of its data, such as `detail.file`. The Runtime resolves it from the adopted Observation and verifies that its source View is still live. A closed or replaced receiver and a closed Ref source are checked independently. The App owns current business validation, and the Host owns execution and receipt authorization.

Both example calls use one Observation: the Ref remains its original frozen value after the edit. The current View contains the updated business text. Receipts do not repeat either text. Observe prepares one candidate alongside the current observation. Adoption revokes the previous calling eligibility and releases its source. Use preview() for read-only rendering without reserving a candidate.

A valid handler return maps to succeeded or failed according to its `success` field. The receipt retains the application's error and data. An execution that finishes after a throw or invalid result can produce a terminal receipt with `status: 'unknown'` and `ACTION_OUTCOME_UNKNOWN`. Use the current View and the App's recovery data when write effects are uncertain.

Hosts can query a terminal receipt with `readReceipt({ observationId, invocationId }, timeoutMs?)` using the two IDs from the original invocation. Each read uses the original instance's receipt policy, including after adoption of a new Observation. An identical invocation request joins the original record while it is retained. A reused invocation ID with different input or a different Observation is rejected.

| Deadline condition | Result |
| --- | --- |
| The initial invocation's deadline prevents dispatch | `kind: 'unavailable'` with `INVOCATION_DEADLINE_EXCEEDED`. Once admission work settles, the original receipt records a `not-dispatched` rejection. |
| Waiting for a terminal result or receipt authorization reaches its deadline | `kind: 'unavailable'` with `INVOCATION_WAIT_TIMEOUT`. Query the original IDs to recover the result. |

Both timeout errors carry only a code and message. The terminal receipt's `completedAt` records actual settlement, and its retention period starts there. A deadline on `readReceipt` or an identical request applies to that wait. Runtime keeps dispatched work and the original input source until execution settles. [Runtime shutdown](runtime-shutdown.md)

模块初始化或首次渲染失败时，宿主可检查本地 cause 链；见 [INIT / OPEN 诊断说明](initialization-diagnostics.md)。这些开发诊断不会自动进入 ToolResult 或 View。

采用新观察后，Host 发起新调用须使用新 Observation、其中的 Tool ID 和接收页面。Node Worker Host 为省略 `timeoutMs` 的调用和收据查询应用默认期限。 [Worker 与 App 资源归属](worker-lifecycle.md) [Semantic Host 集成](semantic-host-integration.zh-CN.md)

## 托管页面的容量准入

托管 Worker 在安装 View 和 Tool 绑定前按默认全量观察规格检查普通 TypeScript 和 Preact 的完整候选。计量使用与观察相同的 View、Ref 元数据、共享 Tool 和可接收页面列表，并为 Snapshot 与 Observation 的标识符和 revision 预留最大计数宽度。默认上限包括 256 个 View、512 个 Ref、256 个 Tool 和 704 KiB 观察 JSON，及现有 JSON 结构与元数据上限。

已有帧上可放弃的新页面打开可使用 `publish({ views }, { opening: true })`，或 Preact 的 `prepareProjection(update, { revert })`。可撤回的打开因观察容量被拒绝时，Runtime 保留已提交身份、绑定与 epoch。Preact 还会核对恢复渲染与原投影及挂载身份的一致性。一般准备故障和发生业务变化后的发布拒绝通过原投影诊断报告。成功观察包含当前快照里的全量打开页面，`preview()` 反映同一已接受来源。 [SDK 作者指南](../../sdk/docs/app-authoring.md#preact-的局部提交反馈)

该准入使用默认单 App 内容规格，由托管 Worker 装配。直接 Core Producer 可以按自己的消费规格安排候选检查。自定义 Host 策略、实时资源持有和组装后的模型请求仍在各自入口检查。

## 身份与元数据来源

`createApp` 与 `createTUIApp` 的 app_name、whatItIs、whenToUse 只在工厂声明中写一次。现有构建脚本从工厂及 package.json 的版本、入口等分发字段生成 aoapp.json。Registry 读取这个静态文件，不 import App 来发现名称或说明；缺失／损坏生成物拒绝为 APP_MANIFEST_INVALID，不猜 package.json main 或 index.js。注册 key 必须与生成的 app_name 相同，配置中的 alias/说明覆盖退出。Worker 在调用 `initialize(context)` 前核对 INIT.appName 与工厂 kernelConfig.appName，不用展示标签代替逻辑名称。

| 对象 | 生成方与唯一范围 | 生命周期与执行用途 |
| --- | --- | --- |
| app_name | 作者；生成清单和 Registry 中唯一 | 逻辑应用名称可在重新安装时复用；标准 Source 的工具前缀；不是某次运行的权限或 ID |
| App ID | Runtime/AppManager；Desktop 内唯一 | 安装对象身份，跨关闭／重开可保留；调用必须再匹配本次 instanceId |
| App instanceId | Runtime；每次逻辑执行新建 | 旧 Context 不得命中同 App ID 的继任执行；每次使用全新 Worker |
| View id/type/name | 作者；id 在 App 的当前挂载集合内唯一 | id 是逻辑页面，type 激活共享工具，name 是呈现标签。SDK 的 id 使用非空 ASCII 字母、数字或下划线；纯 Core 的 id 遵循非空、无点、唯一性与容量规则。 |
| View instanceId | Runtime；每次挂载新建 | 同 id 重挂不恢复旧 Ref 资格；Core 的 owner 与实例来源检查使用它 |
| Tool name 与内部 id | 作者声明 name，Runtime/Core 生成 `[appId, viewType, name]` 的结构化标识 | 同类型共享一份定义。运行绑定由各打开的页面提供，内部身份独立于外部工具名 |
| 原生 Tool 别名 | Source 默认生成 `appName-toolName`。跨 ViewType 同名或短名命中 Desktop 保留别名时加入 `ViewType` | 实际名称段使用 ASCII 字母、数字和下划线，连字符作分隔。总长至多 64 字符，名称诊断作用于对应 App。见 [Source 命名规则](semantic-host-integration.zh-CN.md#native-tool-aliases) |
| Ref 局部名与调用地址 | 作者；同一个 View 内唯一 | 展示保持类型提示；调用为 view_id.local_ref。只有所绑定 Observation 的来源和 View instance 可解析，局部名可在其他 View 复用 |
| Snapshot id/revision | Core；绑定 App 执行实例的已提交版本 | 当前状态只显示最新有效版本；不是业务对象 ID，也不能作为无需再观察的永久资格 |
| Observation id | App instance | 一次准备出的来源集合；显式采用新观察撤销本实例的旧资格并释放旧观察专属数据 |
| activation id | Runtime/Core；每个 View 实例的每项启用操作 | 持续启用时更新 handler 保留资格，单个页面禁用或关闭即撤销其资格。再次启用生成新身份 |
| 状态 appKey | 可信 Host；既有 StateAddress 的 namespace | Registry 默认使用 canonical app_name；Host 可显式传 AOTUI_APP_KEY 选择独立 namespace，不改变注册名、调用目标或 Ref 资格。无通用数据作用域系统 |

SDK 从作者声明的 `app_name` 生成 `kernelConfig.appName`。生成器用它写入 `aoapp.json`，Worker 校验工厂与安装时登记的名称一致。AppKernel 使用 Runtime 分配的 App ID。Host 可用 `AOTUI_APP_KEY` 显式指定持久化命名空间。

工厂标记为 `view-type-tools-v5`，快照为 V5，工具 IPC 为 V6。生命周期和持久化使用 `app-lifecycle-v2` 与 `state-session-v1`。SDK、Runtime 与 Source 使用同一批配套构建。

## 2026-11-09 减法迁移

- `AppContext` 仅携带 `appId`／`desktopId`。SDK 在成功的 Preact 提交中准备 View、Ref 与 Tool，Worker 从缓存发送结果。自定义 Producer 使用 projection 提交边界。
- `IDesktopManager` 直接描述 Kernel 实际使用的服务，不再继承四个未独立使用的接口。Manager 层的 `has` 与安装转发退出；查询使用 `get`，动态安装使用现有 Runtime 或 Desktop 入口。
- 删除未被观察入口消费的 App 日志缓存、`getAppActivityLogs`、`logAppActivity` 和 `logger.maxAppLogs`。App 生命周期事件进入原有有界系统日志，日志额度仍由 `logger.maxSystemLogs` 控制；旧配置明确拒绝。
- 删除 `DataPayload` 转导出，外部事件 payload 仍为 `Record<string, unknown>`；实际 CLI 事件输入与 Worker 事件分发保留。
- 移除 App 注册配置中没有生效的 `version` 声明。CLI 的安装版本来自安装器实际记录的 `distribution.resolvedVersion`，不是第二份手写约束。App package／manifest 版本和配置文件版本继续保留。

这些退出不改变 Tool／Ref／Observation、执行前校验、部分或未知结果、持久化与关闭释放合同。
