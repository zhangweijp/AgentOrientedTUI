# Runtime App 公共交互

Runtime 对可信 Host 提供 App 安装与 Scope 创建入口。当前 Worker interaction modes 只有 `ordinary-v2` 和 `snapshot-value-v2`；应用使用 SDK 声明 View-local Tool，Runtime 把一次已观察的 View、Tool 和 Binding 作为本次调用依据。

## 应用声明

普通参数和只读 Snapshot Ref 都使用 `useViewTypeTool`。普通参数使用 `ordinary-v2`，可用于查询和应用变更；声明 Snapshot Ref 的 Tool 必须是只读，并通过 `snapshot-value-v2` 提供当前观察中的值。业务资源检查和副作用由应用负责，Tool 成功返回 `OperationResult` 收据数据，业务正文放进 View。

下面的示例演示一个普通变更 Tool 和一个只读 Snapshot Ref Tool。`useAppLifecycle` 仅供确实拥有外部资源的组件使用；`createTUIApp` 返回的 managed factory 默认声明 `app-lifecycle-v2` 支持，不需要 lifecycle 配置开关。

<!-- b2-app:start -->
```js
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { createTUIApp, View, useDataRef, useViewTypeTool } from '@aotui/sdk';

function Detail() {
  const file = useDataRef('file', { text: 'original' });
  const [count, setCount] = useState(0);
  const result = async args => {
    if (args.text === 'throw') throw new Error('The operation result is unknown.');
    setCount(current => current + 1);
    return { success: true, data: { message: 'Change completed.' } };
  };
  useViewTypeTool('ordinary', {
    description: 'Apply a change and return a compact receipt.',
    params: { text: { type: 'string', required: true } }, isMutating: true,
  }, result);
  const ref = { type: 'reference', required: true, refSource: 'snapshot-value-v1' };
  useViewTypeTool('ref', {
    description: 'Check that the displayed value is available.', params: { file: ref }, isMutating: false,
  }, async args => ({ success: true, data: { currentValueAvailable: args.file?.text === 'original' } }));
  return h('section', {}, file('Current file value'), h('p', {}, `Completed operations: ${count}`));
}
function Root() {
  return h(View, { id: 'detail', type: 'Detail' }, h(Detail, {}));
}
export default createTUIApp({ app_name: 'interaction_example', component: Root });
```
<!-- b2-app:end -->

`refSource: 'snapshot-value-v1'` identifies the Ref provenance contract. The Host interaction mode for snapshot-valued Ref parameters is `snapshot-value-v2`; these are different fields with different meanings.

## Host installation and Scope

The install option is trusted Host configuration. It is not an App launch setting and cannot be supplied by model input. The following example installs a Worker App, enables both current modes, and opens a Scope through the Runtime Kernel:

<!-- b2-example:start -->
```ts
import { createRuntime, type InteractionMode } from '@aotui/runtime';
import type { ScopePolicy, ScopeClient, Observation } from '@aotui/runtime/core';

export async function runExample(appUrl: string, dataDirectory: string) {
  const runtime = createRuntime({ worker: { timeoutMs: 4000, pool: { initialSize: 0, maxSize: 2 } } });
  const desktopId = await runtime.createDesktop();
  const desktop = runtime.getDesktop(desktopId);
  const modes: InteractionMode[] = ['ordinary-v2', 'snapshot-value-v2'];
  const policy: ScopePolicy = {
    project: ({ source, selection }) => {
      const views = source.views.filter(v => selection.viewIds.includes(v.id));
      return {
        views: views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
        refs: Object.values(source.refs).filter(r => selection.viewIds.includes(r.ownerViewId)).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        targets: Object.values(source.tools).flatMap(t => t.targets.filter(target => selection.viewIds.includes(target.viewId)).map(target => ({ toolId: t.id, target }))),
        content: views.map(view => ({ view: { viewId: view.id, viewInstanceId: view.viewInstanceId }, decision: 'retain' as const })),
      };
    },
    authorize: () => true,
    canReadReceipt: () => true,
  };
  async function observeReady(client: ScopeClient): Promise<Observation> {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      let notify!: () => void;
      const changed = new Promise<void>(resolve => { notify = resolve; });
      desktop.output.subscribe(notify);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await client.observe({ viewIds: ['detail'] });
        if (result.status === 'observed') return result.observation;
        if (result.issue.code === 'SCOPE_UNAVAILABLE') throw Error(result.issue.code);
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
  try {
    const appId = await runtime.installDynamicWorkerApp(desktopId, appUrl, {
      interactionModes: modes,
      config: { AOTUI_DATA_DIR: dataDirectory },
    });
    const opened = runtime.createAppScope(desktopId, appId, policy);
    if (opened.status !== 'opened') throw Error(opened.issue.code);
    const observation = await observeReady(opened.client);
    const requests = [
      { name: 'ordinary', input: { text: 'change' } },
      { name: 'ref', input: { file: 'file' } },
    ];
    const outcomes = [];
    for (const [index, request] of requests.entries()) {
      const tool = observation.tools.find(tool => tool.name === request.name);
      const binding = observation.bindings.find(binding => binding.toolId === tool?.id && binding.target.viewId === 'detail');
      if (!binding) throw Error('Tool binding unavailable');
      const result = await opened.client.invoke({ invocationId: `example-${index}`, observationId: observation.observationId,
        bindingId: binding.bindingId, input: request.input });
      if (result.kind !== 'receipt') throw Error(result.code);
      if (result.receipt.outcome.status !== 'succeeded') throw Error(result.receipt.outcome.status);
      outcomes.push(result.receipt.outcome);
    }
    opened.client.close();
    return { modes, outcomes, close: await runtime.beginShutdown().completion };
  } finally {
    await runtime.beginShutdown().completion;
  }
}
```
<!-- b2-example:end -->

`createAppScope` does not start a pending App or allocate a second Worker. It opens a trusted interaction boundary for a running App; the Host policy chooses visible Views, Refs, and Tool targets and independently authorizes calls and receipt reads. A `SemanticAOTUIDrivenSource` creates and manages these Scopes for an AgentDriver Context; direct Scope construction is for integrations that own the policy and its lifetime.

Each current interaction mode must be declared by the Host, acknowledged by the Worker, and qualified for the actual Tool binding. A visible Tool is not permission. `ordinary-v2` supports ordinary mutating Tool handlers; `snapshot-value-v2` supports only read-only Ref parameters. A default export from `createTUIApp` supplies the managed component factory expected by the Worker.

Scopes retain observed Bindings and receipts until released or closed. The same invocation ID and identical request do not re-enter a handler while its record remains in that Scope; a new Scope does not inherit the old deduplication record. `ScopeClient.readReceipt()` remains a Core API for an authorized integration that owns the original Scope. The standard Semantic Source keeps receipts internal and does not expose a model-facing receipt polling Tool. See [Semantic Host integration](semantic-host-integration.zh-CN.md) for Context ownership and result mapping, and [Runtime shutdown reports](runtime-shutdown.md) for close behavior.
