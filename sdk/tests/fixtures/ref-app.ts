import Type from 'typebox';
import { arrayRef, createApp, createView, defineViewType, formatRef, ref, refParam, type ToolResult, type ViewHandle, type ViewFrame } from '@aotui/sdk';
type FixturePage = { handle: ViewHandle; frame(): ViewFrame };

const NoteSchema = Type.Object({ id: Type.String(), title: Type.String(), text: Type.String() },
  { additionalProperties: false });
const noteRefOptions = { scope: 'private', refType: 'Note', schema: NoteSchema } as const;
const notesRefOptions = { scope: 'private', itemType: 'Note', schema: Type.Array(NoteSchema) } as const;
export const RootType = defineViewType({ multiplicity: 'multiple', name: 'Root' });

export const WorkspaceType = defineViewType<{ opened: boolean; setOpened(value: boolean): ToolResult }>()({ multiplicity: 'multiple', name: 'Workspace', tools: {
        open_notes: { description: 'Open the Notes page.',
            inputSchema: Type.Object({}, { additionalProperties: false }),
            execute({ context }) {
                return context.setOpened(true);
            },
        },
        close_notes: { description: 'Close the Notes page.',
            inputSchema: Type.Object({}, { additionalProperties: false }),
            enabled: ({ opened }) => opened,
            execute({ context }) {
                return context.setOpened(false);
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
export default createApp({
  app_name: 'notes_example', viewTypes: noteViewTypes,
  initialize({ publish: commit, readViewId }) {
    let detail: FixturePage | undefined;
    let inspection = 'No inspection requested.';
    let opening = false;
    const root = (() => { const handle = createView(RootType, { idPrefix: 'root', region: 'static' }); const displayName = 'Notes instructions'; return { handle, frame: () => handle.frame({ name: displayName, body: '# Notes Example Application Instruction\n\nOpen Notes from Workspace and select Refs from the Detail page.' }) }; })();
    const workspace = (() => { const handle = createView(WorkspaceType, { idPrefix: 'workspace', region: 'dynamic' }); const displayName = 'Notes workspace'; return { handle, frame: () => handle.frame({ name: displayName, body: 'Notes are an in-memory example. Open the page to inspect them.', context: { opened: opening || !!detail, setOpened } }) }; })();
    function inspect(selected: readonly Readonly<Type.Static<typeof NoteSchema>>[]): ToolResult {
      if (!detail || selected.some(note => !notes.some(current => current.id === note.id))) return {
        success: false, error: { code: 'NOTE_NOT_AVAILABLE', message: 'Open Notes, refresh, and choose its current Ref.' },
      };
      inspection = selected.length ? selected.map(note => `${note.title}: ${note.text}`).join('\n') : 'No notes selected.';
      commit(() => ([root, workspace, detail!]).map(page => page.frame()));
      return { success: true, data: { view_id: readViewId(detail.handle)!, inspected: true } };
    }
    function setOpened(want: boolean): ToolResult {
      if (want && !detail) {
        const proposed = (() => { const handle = createView(NoteDetailType, { idPrefix: 'detail', region: 'dynamic' }); const displayName = 'Notes'; return { handle, frame: () => {
            const current = ref('current', notes[0]!, noteRefOptions);
            const list = arrayRef('notes', notes, notesRefOptions);
            return handle.frame({ name: displayName, refs: [current, list], context: { inspect }, body: [
                formatRef('Current note: First note', current), formatRef('All notes', list),
                ...notes.flatMap((note, index) => [formatRef(note.title, list, index), note.text]),
                '## Inspection', inspection,
              ].join('\n\n') });
          } }; })();
        opening = true;
        try {
          const result = commit(() => ([root, workspace, proposed]).map(page => page.frame()), { mode: 'candidate' });
          if (!result.ok) return { success: false, error: { code: result.issue.code, message: result.issue.message } };
          detail = proposed;
        } finally { opening = false; }
      } else if (!want && detail) {
        detail = undefined;
        commit(() => ([root, workspace]).map(page => page.frame()));
      }
      return { success: true, data: { message: want ? 'Read Notes.' : 'Notes closed.' } };
    }
    commit(() => ([root, workspace]).map(page => page.frame()));
  },
});
