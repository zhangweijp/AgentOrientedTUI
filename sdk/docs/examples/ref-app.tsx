import Type from 'typebox';
import {
  ToolCatalog, View, createTUIApp, defineViewType,
  refParam, useArrayRef, useDataRef, useState,
} from '@aotui/sdk';

const NoteSchema = Type.Object({ id: Type.String(), title: Type.String(), text: Type.String() },
  { additionalProperties: false });
export const RootType = defineViewType({ name: 'Root', tools: {} });

export const WorkspaceType = defineViewType({ name: 'Workspace', tools: {
        open_notes: { description: 'Open the Notes page.',
            inputSchema: Type.Object({}, { additionalProperties: false }),
        },
        close_notes: { description: 'Close the Notes page.',
            inputSchema: Type.Object({}, { additionalProperties: false }),
        },
} });

export const NoteDetailType = defineViewType({ name: 'NoteDetail', tools: {
        inspect_note: { description: 'Inspect a Note Ref; read the result in Note Detail.',
            inputSchema: Type.Object({ note: refParam('Note', NoteSchema) }, { additionalProperties: false }),
        },
        inspect_notes: { description: 'Inspect one complete Note list Ref; read Note Detail.',
            inputSchema: Type.Object({ notes: refParam('Note', Type.Array(NoteSchema, { maxItems: 50 })) },
      { additionalProperties: false }),
        },
        inspect_selection: { description: 'Inspect ordered Note Refs, optionally with a primary Note and whole list; read Note Detail.',
            inputSchema: Type.Object({
      selected: Type.Array(refParam('Note', NoteSchema), { maxItems: 50 }),
      primary: Type.Optional(refParam('Note', NoteSchema)),
      whole: Type.Optional(refParam('Note', Type.Array(NoteSchema, { maxItems: 50 }))),
    }, { additionalProperties: false }),
        },
} });

export const noteViewTypes = [RootType, WorkspaceType, NoteDetailType] as const;
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
      return { success: false as const,
        error: { code: 'NOTE_NOT_AVAILABLE', message: 'Open Notes, refresh, and choose its current Ref.' } };
    }
    setInspection(selected.length ? selected.map(note => `${note.title}: ${note.text}`).join('\n') : 'No notes selected.');
    return { success: true as const, data: { view_id: 'detail', inspected: true } };
  }
  return <>
    <View kind="instruction" id="root" type={RootType} name="Notes instructions">
      <h1>Notes Example Application Instruction</h1>
      <p>Open Notes from Workspace. Pass the receiving page’s XML id as view_id. Select objects using the containing View id plus its local Ref name:
        detail.current, detail.notes or detail.notes[0]. The displayed Note: prefix is a type hint only.
        Do not copy internal IDs. Read the Inspection section after a receipt. Close Notes when finished.</p>
      <ToolCatalog viewTypes={noteViewTypes} />
    </View>
    <View kind="state" id="workspace" type={WorkspaceType} name="Notes workspace" bindings={{
      open_notes: { execute: () => { setOpened(true); return { success: true, data: { message: 'Read Notes.' } }; } },
      close_notes: { enabled: opened, execute: () => { setOpened(false); return { success: true, data: { message: 'Notes closed.' } }; } },
    }}>
      <p>Notes are an in-memory example. Open the page to inspect them.</p>
    </View>
    {opened && <View kind="state" id="detail" type={NoteDetailType} name="Notes" bindings={{
      inspect_note: { execute: ({ note }) => inspect([note]) },
      inspect_notes: { execute: ({ notes: selected }) => inspect(selected) },
      inspect_selection: { execute: ({ selected, primary, whole }) =>
        inspect([...selected, ...(primary ? [primary] : []), ...(whole ?? [])]) },
    }}>
      <Detail inspection={inspection} />
    </View>}
  </>;
}
export default createTUIApp({ app_name: 'notes_example', component: App, viewTypes: noteViewTypes });
