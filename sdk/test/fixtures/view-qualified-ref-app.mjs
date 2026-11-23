import { h } from 'preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { StaticView, DynamicView, createTUIApp, defineViewType, refParam, useArrayRef } from '@aotui/sdk';

const Phase = Type.Object({ owner: Type.String(), title: Type.String() }, { additionalProperties: false });
const PhasesType = defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'Phases', tools: {
  read_item: {
    description: 'Read one phase.', inputSchema: Type.Object({ phase: refParam('Phase', Phase) }),
    execute: ({ input: { phase } }) => ({ success: true, data: { owner: phase.owner, readonly: Object.isFrozen(phase) } }),
  },
  read_list: {
    description: 'Read displayed phases.', inputSchema: Type.Object({ phases: refParam('Phase', Type.Array(Phase)) }),
    execute: ({ input: { phases } }) => ({ success: true, data: {
      owners: phases.map(phase => phase.owner), readonly: Object.isFrozen(phases) && phases.every(Object.isFrozen),
    } }),
  },
} });
const Guide = defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'Guide', tools: {
  update_b: {
    description: 'Update plan B.', inputSchema: Type.Object({}),
    execute: ({ context }) => { context.setOwner('B updated'); return { success: true }; },
  },
  close_b: {
    description: 'Close plan B.', inputSchema: Type.Object({}),
    execute: ({ context }) => { context.setOpen(false); return { success: true }; },
  },
} });
function Phases({ owner }) {
  const [list, item] = useArrayRef('completed_phases', [{ owner, title: 'Design ' + owner }], { scope: 'protected', itemType: 'Phase' });
  return h('section', {}, [h('h2', {}, list('Completed phases')), h('p', {}, item(0, 'Design ' + owner))]);
}
function App() {
  const [owner, setOwner] = useState('B');
  const [open, setOpen] = useState(true);
  return h('main', {}, [
    h(StaticView, { idPrefix: 'root', type: Guide, context: { setOwner, setOpen } },
      'Select a Ref using its containing View id and local name.'),
    h(DynamicView, { idPrefix: 'plan_a', type: PhasesType, context: {} }, h(Phases, { owner: 'A' })),
    open ? h(DynamicView, { idPrefix: 'plan_b', type: PhasesType, context: {} }, h(Phases, { owner })) : null,
  ]);
}
export default createTUIApp({ app_name: 'refviews', component: App, viewTypes: [Guide, PhasesType] });
