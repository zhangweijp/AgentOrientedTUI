import { createRuntime, readAppManifest, type AppManifest, type RegisterPendingAppOptions, type RunningApp, type AppInvocation, type ObservationCandidate,
  type ProjectionLimitOverrides, type ReceiptQuery } from '@aotui/runtime';

export async function runManagedHost(localPath: string, dataDirectory: string) {
  const runtime = createRuntime({ worker: { timeoutMs: 4000, maxWorkers: 2 } });
  try {
    const desktop = await runtime.createDesktop();
    async function observeReady(client: RunningApp): Promise<ObservationCandidate> {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        let notify!: () => void;
        const changed = new Promise<void>(resolve => { notify = resolve; });
        desktop.output.subscribe(notify);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await client.observe();
          if (result.status === 'prepared') return result.candidate;
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
    const manifest: AppManifest = await readAppManifest(localPath);
    if (manifest.metadata.app_name !== 'interaction_example') throw Error('Unexpected manifest');
    const registration: RegisterPendingAppOptions = {
      installationId: 'interaction_install', localPath, projectionLimits,
      config: { AOTUI_DATA_DIR: dataDirectory },
    };
    const installationId = await desktop.registerPendingApp(registration);
    const client = await desktop.openApp(installationId);
    const { appId } = client;
    const outcomes = [];
    const candidate = await observeReady(client);
    const { observation } = candidate;
    const adopted = desktop.adoptTurn({ apps: [{ candidate }] });
    if (adopted.status !== 'adopted') throw Error(adopted.issue.code);
    try {
      const requests: readonly { name: string; input: AppInvocation['input'] }[] = [
        { name: 'ordinary', input: { text: 'change' } },
        { name: 'ref', input: { file: '$ref.' + appId + '.detail_1.file' } },
      ];
      for (const [index, request] of requests.entries()) {
        const tool = observation.tools.find(tool => tool.name === request.name);
        if (!tool) throw Error('Tool unavailable');
        const result = await adopted.turn.invoke(appId, { invocationId: `example-${index}`, observationId: observation.observationId,
          toolId: tool.id, viewId: 'detail_1', input: request.input });
        if (result.kind !== 'receipt') throw Error(result.code);
        if (result.receipt.outcome.status !== 'succeeded') throw Error(result.receipt.outcome.status);
        outcomes.push(result.receipt.outcome);
      }
    } finally {
      adopted.turn.release();
    }
    const query: ReceiptQuery = { observationId: observation.observationId, invocationId: 'example-0' };
    const original = await client.readReceipt(query);
    if (original.kind !== 'receipt' || original.receipt.outcome.status !== 'succeeded') {
      throw Error('Original receipt unavailable');
    }
    const close = await runtime.beginClose().completion;
    if (!close.ok || !close.resourcesReleased) throw Error('Runtime shutdown did not complete successfully');
    return { outcomes, close };
  } finally {
    const close = await runtime.beginClose().completion;
    if (!close.resourcesReleased) throw Error('Runtime resource release is incomplete');
  }
}
