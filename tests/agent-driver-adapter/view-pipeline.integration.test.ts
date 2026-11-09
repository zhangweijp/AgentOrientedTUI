import { expect, it } from 'vitest';
import { runViewPipeline } from '../fixtures/view-pipeline-consumer.mjs';

it('publishes explicit View metadata and faithful XML/Markdown through real Worker, Source and both Producers', async () => {
    const facts = await runViewPipeline(new URL('../../sdk/tests/fixtures/view-pipeline-app.mjs', import.meta.url).href);
    expect(facts.producerParity.kind).toBe('state');
    expect(facts.calls.filter(call => call.tool === 'update')).toHaveLength(1);
    expect(facts.close.resourcesReleased).toBe(true);
}, 30_000);
