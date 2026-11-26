import { arrayRef, createApp, createView, defineViewType, formatRef, refParam } from '@aotui/sdk';

const Phase = {
    type: 'object', properties: { owner: { type: 'string' }, title: { type: 'string' } },
    required: ['owner', 'title'], additionalProperties: false,
};
const Phases = { type: 'array', items: Phase };
const input = (name, value) => ({ type: 'object', properties: { [name]: value }, required: [name], additionalProperties: false });
const success = { success: true };

const Plan = defineViewType()({ multiplicity: 'multiple', name: 'Phases', region: 'dynamic', tools: {
    read_item: {
        description: 'Read one phase.', inputSchema: input('phase', refParam('Phase', Phase)),
        execute: ({ input: { phase } }) => ({ success: true, data: { owner: phase.owner, readonly: Object.isFrozen(phase) } }),
    },
    read_list: {
        description: 'Read displayed phases.', inputSchema: input('phases', refParam('Phase', Phases)),
        execute: ({ input: { phases } }) => ({ success: true, data: {
            owners: phases.map(phase => phase.owner), readonly: Object.isFrozen(phases) && phases.every(Object.isFrozen),
        } }),
    },
} });
const Guide = defineViewType()({ multiplicity: 'multiple', name: 'Guide', region: 'static', tools: {
    update_b: { description: 'Update plan B.', execute: ({ context }) => context.setOwner('B updated') },
    close_b: { description: 'Close plan B.', execute: ({ context }) => context.close() },
} });

export default createApp({
    app_name: 'refviews', viewTypes: [Guide, Plan],
    initialize({ prepareProjection }) {
        let ownerB = 'B', open = true;
        const guide = createView(Guide, { idPrefix: 'root', render: () => ({
            body: 'Select a Ref using its containing View id and local name.',
            context: {
                setOwner(owner) { ownerB = owner; publish(); return success; },
                close() { open = false; publish(); return success; },
            },
        }) });
        const plan = (idPrefix, readOwner) => createView(Plan, { idPrefix, render() {
            const owner = readOwner();
            const title = 'Design ' + owner;
            const phases = arrayRef('completed_phases', [{ owner, title }], { schema: Phases, scope: 'protected', itemType: 'Phase' });
            return { body: `## ${formatRef('Completed phases', phases)}\n${formatRef(title, phases, 0)}`, refs: [phases], context: {} };
        } });
        const a = plan('plan_a', () => 'A');
        const b = plan('plan_b', () => ownerB);
        function publish() { prepareProjection({ views: open ? [guide, a, b] : [guide, a] }); }
        publish();
    },
});
