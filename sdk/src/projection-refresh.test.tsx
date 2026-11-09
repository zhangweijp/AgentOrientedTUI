import { afterEach, describe, expect, it } from 'vitest';
import { h, options } from 'preact';
import { act } from 'preact/test-utils';
import { useMemo, useState } from 'preact/hooks';
import Type from 'typebox';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { AppTools } from './components/AppTools.js';
import { View } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { defineToolSet, defineViewTypeTool } from './tools/view-type-tool.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const previous = options.debounceRendering;
afterEach(() => { options.debounceRendering = previous; });

async function fixture(insideAct = false) {
    const queue: Array<() => void> = [];
    options.debounceRendering = callback => { queue.push(callback); };
    let update!: (value: number) => void;
    const tools = defineToolSet({ edit: defineViewTypeTool({ viewType: 'File', name: 'edit',
        description: 'Edit', inputSchema: Type.Object({}) }) });
    function Content({ value }: { value: number }) {
        const data = useMemo(() => ({ value }), [value]);
        const ref = useDataRef('selected', data);
        return h('p', {}, 'body:' + value + ref('Selection'));
    }
    function App() {
        const [value, set] = useState(0); update = set;
        return h(AppTools, { definition: tools, bindings: { edit: { enabled: value > 0, execute: () => ({ success: true }) } } },
            h(View, {kind: 'state', id: 'file', type: 'File' }, h(Content, { value })));
    }
    const factory = createTUIApp({ app_name: 'refresh_app', component: App });
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
    kernel.setId('refresh_app' as any);
    const container = document.createElement('div');
    const open = () => kernel.onOpen({ appId: 'refresh_app' as any, desktopId: 'desktop' as any,
         }, container);
    if (insideAct) await act(async () => { await open(); }); else await open();
    return { kernel, container, update, queue, flush: () => { while (queue.length) queue.shift()!(); } };
}

describe('SDK queued render commit completion', () => {
    it.each([false, true])('joins the real queued callback after initialization in act: %s', async insideAct => {
        const x = await fixture(insideAct);
        let committed: Promise<void> | undefined;
        try {
            x.update(1);
            let complete = false;
            committed = x.kernel.whenProjectionCommitted().then(() => { complete = true; });
            // Expose premature settlement while the actual scheduler is still blocked.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(x.queue).toHaveLength(1);
            expect(complete).toBe(false);
            expect(x.container.textContent).toContain('body:0');
            expect(x.kernel.getViewRefs()[0]?.value).toEqual({ value: 0 });
            expect(x.kernel.getToolDefinitions()).toEqual([]);
            x.flush(); await committed;
            expect(complete).toBe(true);
            expect(x.container.textContent).toContain('body:1');
            expect(x.kernel.getViewRefs()[0]?.value).toEqual({ value: 1 });
            expect(x.kernel.getToolDefinitions().map(t => t.name)).toEqual(['edit']);
            const epoch = x.kernel.getProjectionCoordinator().token();
            await x.kernel.whenProjectionCommitted();
            expect(x.kernel.getProjectionCoordinator().token()).toEqual(epoch);
        } finally { x.flush(); await committed; await x.kernel.onClose(); }
    });

    it('ends its wait on App close even when the application scheduler never runs', async () => {
        const x = await fixture();
        x.update(1);
        const waiting = x.kernel.whenProjectionCommitted();
        x.kernel.beginShutdown();
        await expect(waiting).rejects.toMatchObject({ code: 'PROJECTION_CLOSED' });
        await x.kernel.onClose();
        x.flush();
    });
});
