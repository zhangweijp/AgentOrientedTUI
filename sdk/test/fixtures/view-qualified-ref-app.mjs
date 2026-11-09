import { h } from 'preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { AppTools, View, createTUIApp, defineToolSet, defineViewTypeTool, refParam, useArrayRef } from '@aotui/sdk';

const Phase = Type.Object({ owner: Type.String(), title: Type.String() }, { additionalProperties: false });
const define = (viewType, name, inputSchema) => defineViewTypeTool({ viewType, name, description: name, inputSchema });
const tools = defineToolSet({
  item: define('Phases', 'read_item', Type.Object({ phase: refParam('Phase', Phase) })),
  list: define('Phases', 'read_list', Type.Object({ phases: refParam('Phase', Type.Array(Phase)) })),
  update: define('Guide', 'update_b', Type.Object({})),
  close: define('Guide', 'close_b', Type.Object({})),
});
function Phases({ owner }) {
  const [list, item] = useArrayRef('completed_phases', [{ owner, title: 'Design ' + owner }], { itemType: 'Phase' });
  return h('section', {}, [h('h2', {}, list('Completed phases')), h('p', {}, item(0, 'Design ' + owner))]);
}
function App() {
  const [owner, setOwner] = useState('B');
  const [open, setOpen] = useState(true);
  return h(AppTools, { definition: tools, bindings: {
    item: { execute: ({ phase }) => ({ success: true, data: { owner: phase.owner, readonly: Object.isFrozen(phase) } }) },
    list: { execute: ({ phases }) => ({ success: true, data: { owners: phases.map(p => p.owner), readonly: Object.isFrozen(phases) && phases.every(Object.isFrozen) } }) },
    update: { execute: () => { setOwner('B updated'); return { success: true }; } },
    close: { execute: () => { setOpen(false); return { success: true }; } },
  } }, [
    h(View, { id: 'root', type: 'Guide', kind: 'instruction' }, 'Select a Ref using its containing View id and local name.'),
    h(View, { id: 'plan_a', type: 'Phases', kind: 'state' }, h(Phases, { owner: 'A' })),
    open ? h(View, { id: 'plan_b', type: 'Phases', kind: 'state' }, h(Phases, { owner })) : null,
  ]);
}
export default createTUIApp({ app_name: 'refviews', component: App });
