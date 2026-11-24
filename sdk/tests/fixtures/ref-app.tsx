import Type from 'typebox';
import {
  StaticView, DynamicView, createTUIApp, defineViewType,
  refParam, type ToolResult, useArrayRef, useDataRef, useState,
} from '@aotui/sdk';

const NoteSchema = Type.Object({ id: Type.String(), title: Type.String(), text: Type.String() },
  { additionalProperties: false });
const noteRefOptions = { scope: 'private', refType: 'Note', schema: NoteSchema } as const;
const notesRefOptions = { scope: 'private', itemType: 'Note', schema: Type.Array(NoteSchema) } as const;
export const RootType = defineViewType({ multiplicity: 'multiple', name: 'Root' });

export const WorkspaceType = defineViewType<{ opened: boolean; setOpened(value: boolean): void }>()({ multiplicity: 'multiple', name: 'Workspace', tools: {
        open_notes: { description: 'Open the Notes page.',
            inputSchema: Type.Object({}, { additionalProperties: false }),
            execute({ context }) {
                context.setOpened(true);
                return { success: true, data: { message: 'Read Notes.' } };
            },
        },
        close_notes: { description: 'Close the Notes page.',
            inputSchema: Type.Object({}, { additionalProperties: false }),
            enabled: ({ opened }) => opened,
            execute({ context }) {
                context.setOpened(false);
                return { success: true, data: { message: 'Notes closed.' } };
            },
        },
} });

export const NoteDetailType = defineViewType<{ inspect(notes: readonly Readonly<Type.Static<typeof NoteSchema>>[]): ToolResult }>()({ multiplicity: 'multiple', name: 'NoteDetail', tools: {
        inspect_note: { description: 'Inspect a Note Ref; read the result in Note Detail.',
            inputSchema: Type.Object({ note: refParam('Note', NoteSchema) }, { additionalProperties: false }),
            execute: ({ input, context }) => context.inspect([input.note]),
        },
        inspect_notes: { description: 'Inspect one complete Note list Ref; read Note Detail.',
            inputSchema: Type.Object({ notes: refParam('Note', Type.Array(NoteSchema, { maxItems: 50 })) },
      { additionalProperties: false }),
            execute: ({ input, context }) => context.inspect(input.notes),
        },
        inspect_selection: { description: 'Inspect ordered Note Refs, optionally with a primary Note and whole list; read Note Detail.',
            inputSchema: Type.Object({
      selected: Type.Array(refParam('Note', NoteSchema), { maxItems: 50 }),
      primary: Type.Optional(refParam('Note', NoteSchema)),
      whole: Type.Optional(refParam('Note', Type.Array(NoteSchema, { maxItems: 50 }))),
    }, { additionalProperties: false }),
            execute: ({ input: { selected, primary, whole }, context }) =>
                context.inspect([...selected, ...(primary ? [primary] : []), ...(whole ?? [])]),
        },
} });

export const noteViewTypes = [RootType, WorkspaceType, NoteDetailType] as const;
const notes = [
  { id: 'internal_a', title: 'First note', text: 'First line\nSecond line' },
  { id: 'internal_b', title: 'Second note', text: 'Another note' },
];
function Detail({ inspection }: { inspection: string }) {
  const noteRef = useDataRef('current', notes[0]!, noteRefOptions);
  const [listRef, itemRef] = useArrayRef('notes', notes, notesRefOptions);
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
    <StaticView  idPrefix="root" type={RootType} name="Notes instructions">
      <h1>Notes Example Application Instruction</h1>
      <p>Open Notes from Workspace. Pass the receiving page’s XML view_id to its tools. Select Notes from the detail page with
        $ref.app_id.detail.current, $ref.app_id.detail.notes or $ref.app_id.detail.notes[0], using the app_id from its XML.
        Read the Inspection section after a receipt. Close Notes when finished.</p>
    </StaticView>
    <DynamicView  idPrefix="workspace" type={WorkspaceType} name="Notes workspace" context={{ opened, setOpened }}>
      <p>Notes are an in-memory example. Open the page to inspect them.</p>
    </DynamicView>
    {opened && <DynamicView  idPrefix="detail" type={NoteDetailType} name="Notes" context={{ inspect }}>
      <Detail inspection={inspection} />
    </DynamicView>}
  </>;
}
export default createTUIApp({ app_name: 'notes_example', component: App, viewTypes: noteViewTypes });
