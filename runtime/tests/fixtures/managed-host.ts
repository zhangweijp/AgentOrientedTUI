import { createRuntime, type AppInteraction, type AppInvocation, type Observation, type ObservationSelection,
  type ProjectionLimitOverrides, type ReceiptQuery } from '@aotui/runtime';

export async function runManagedHost(appUrl: string, dataDirectory: string) {
  const runtime = createRuntime({ worker: { timeoutMs: 4000, maxWorkers: 2 } });
  try {
    const desktopId = await runtime.createDesktop();
    const desktop = runtime.getDesktop(desktopId);
    const selection: ObservationSelection = { all: true };
    async function observeReady(client: AppInteraction): Promise<Observation> {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        let notify!: () => void;
        const changed = new Promise<void>(resolve => { notify = resolve; });
        desktop.output.subscribe(notify);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await client.observe(selection);
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
    const projectionLimits: ProjectionLimitOverrides = { maxViews: 2,
      observation: { maxApproxBytes: 128 * 1024, maxCanonicalBytes: 128 * 1024 } };
    const appId = await runtime.installDynamicWorkerApp(desktopId, appUrl, {
      projectionLimits,
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
      const requests: readonly { name: string; input: AppInvocation['input'] }[] = [
        { name: 'ordinary', input: { view_id: 'detail', text: 'change' } },
        { name: 'ref', input: { view_id: 'detail', file: 'detail.file' } },
      ];
      for (const [index, request] of requests.entries()) {
        const tool = observation.tools.find(tool => tool.name === request.name);
        if (!tool) throw Error('Tool unavailable');
        const result = await client.invoke({ invocationId: `example-${index}`, observationId: observation.observationId,
          toolId: tool.id, input: request.input });
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
