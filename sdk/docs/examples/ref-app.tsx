import Type from 'typebox';
import {
  AppTools, ToolCatalog, View, createTUIApp, defineToolSet, defineViewTypeTool,
  refParam, useArrayRef, useDataRef, useState,
} from '@aotui/sdk';

const NoteSchema = Type.Object({ id: Type.String(), title: Type.String(), text: Type.String() },
  { additionalProperties: false });
const tools = defineToolSet({
  open: defineViewTypeTool({ viewType: 'Workspace', name: 'open_notes',
    description: 'Open the Notes page.', inputSchema: Type.Object({}, { additionalProperties: false }) }),
  close: defineViewTypeTool({ viewType: 'Workspace', name: 'close_notes',
    description: 'Close the Notes page.', inputSchema: Type.Object({}, { additionalProperties: false }) }),
  inspect: defineViewTypeTool({ viewType: 'NoteDetail', name: 'inspect_note',
    description: 'Inspect a Note Ref; read the result in Note Detail.',
    inputSchema: Type.Object({ note: refParam('Note', NoteSchema) }, { additionalProperties: false }) }),
  inspectList: defineViewTypeTool({ viewType: 'NoteDetail', name: 'inspect_notes',
    description: 'Inspect one complete Note list Ref; read Note Detail.',
    inputSchema: Type.Object({ notes: refParam('Note', Type.Array(NoteSchema, { maxItems: 50 })) },
      { additionalProperties: false }) }),
  inspectSelection: defineViewTypeTool({ viewType: 'NoteDetail', name: 'inspect_selection',
    description: 'Inspect ordered Note Refs, optionally with a primary Note and whole list; read Note Detail.',
    inputSchema: Type.Object({
      selected: Type.Array(refParam('Note', NoteSchema), { maxItems: 50 }),
      primary: Type.Optional(refParam('Note', NoteSchema)),
      whole: Type.Optional(refParam('Note', Type.Array(NoteSchema, { maxItems: 50 }))),
    }, { additionalProperties: false }) }),
});
const notes = [
  { id: 'internal_a', title: 'First note', text: 'First line\nSecond line' },
  { id: 'internal_b', title: 'Second note', text: 'Another note' },
];
function Detail({ inspection }: { inspection: string }) {
  const noteRef = useDataRef('current', notes[0]!, { refType: 'Note' });
  const [listRef, itemRef] = useArrayRef('notes', notes, { itemType: 'Note' });
  return <>
    <p>{noteRef('Current note: First note')}</p>
    <p>{listRef('All notes')}</p>
    {notes.map((note, index) => <section key={note.id}>
      <p>{itemRef(index, note.title)}</p><pre>{note.text}</pre>
    </section>)}
    <h2>Inspection</h2><pre>{inspection}</pre>
  </>;
}
function App() {
  const [opened, setOpened] = useState(false);
  const [inspection, setInspection] = useState('No inspection requested.');
  function inspect(selected: readonly { readonly id: string; readonly title: string; readonly text: string }[]) {
    if (!opened || selected.some(note => !notes.some(current => current.id === note.id))) {
      return { success: false as const, effects: 'none' as const,
        error: { code: 'NOTE_NOT_AVAILABLE', message: 'Open Notes, refresh, and choose its current Ref.' } };
    }
    setInspection(selected.length ? selected.map(note => `${note.title}: ${note.text}`).join('\n') : 'No notes selected.');
    return { success: true as const, data: { view_id: 'detail', inspected: true } };
  }
  return <AppTools definition={tools} bindings={{
    open: { execute: () => { setOpened(true); return { success: true, data: { message: 'Read Notes.' } }; } },
    close: { enabled: opened, execute: () => { setOpened(false); return { success: true, data: { message: 'Notes closed.' } }; } },
    inspect: { enabled: opened, execute: ({ note }) => inspect([note]) },
    inspectList: { enabled: opened, execute: ({ notes: selected }) => inspect(selected) },
    inspectSelection: { enabled: opened, execute: ({ selected, primary, whole }) =>
      inspect([...selected, ...(primary ? [primary] : []), ...(whole ?? [])]) },
  }}>
    <View kind="instruction" id="root" type="Root" name="Notes instructions">
      <h1>Notes Example Application Instruction</h1>
      <p>Open Notes from Workspace. Select objects using the containing View id plus its local Ref name:
        detail.current, detail.notes or detail.notes[0]. The displayed Note: prefix is a type hint only.
        Do not copy internal IDs. Read the Inspection section after a receipt. Close Notes when finished.</p>
      <ToolCatalog definition={tools} />
    </View>
    <View kind="state" id="workspace" type="Workspace" name="Notes workspace">
      <p>Notes are an in-memory example. Open the page to inspect them.</p>
    </View>
    {opened && <View kind="state" id="detail" type="NoteDetail" name="Notes">
      <Detail inspection={inspection} />
    </View>}
  </AppTools>;
}
export default createTUIApp({ app_name: 'notes_example', component: App });
