import Type from 'typebox';
import { arrayRef, createApp, createView, defineViewType, formatRef, ref, refParam, type ToolResult, type ViewHandle } from '@aotui/sdk';

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
  initialize({ prepareProjection, prepareOpeningProjection, readViewId }) {
    let detail: ViewHandle | undefined;
    let inspection = 'No inspection requested.';
    let opening = false;
    const root = createView(RootType, {
      idPrefix: 'root', region: 'static', name: 'Notes instructions',
      render: () => ({ body: '# Notes Example Application Instruction\n\nOpen Notes from Workspace and select Refs from the Detail page.' }),
    });
    const workspace = createView(WorkspaceType, {
      idPrefix: 'workspace', region: 'dynamic', name: 'Notes workspace',
      render: () => ({
        body: 'Notes are an in-memory example. Open the page to inspect them.',
        context: { opened: opening || !!detail, setOpened },
      }),
    });
    function inspect(selected: readonly Readonly<Type.Static<typeof NoteSchema>>[]): ToolResult {
      if (!detail || selected.some(note => !notes.some(current => current.id === note.id))) return {
        success: false, error: { code: 'NOTE_NOT_AVAILABLE', message: 'Open Notes, refresh, and choose its current Ref.' },
      };
      inspection = selected.length ? selected.map(note => `${note.title}: ${note.text}`).join('\n') : 'No notes selected.';
      prepareProjection({ views: [root, workspace, detail] });
      return { success: true, data: { view_id: readViewId(detail)!, inspected: true } };
    }
    function setOpened(want: boolean): ToolResult {
      if (want && !detail) {
        const proposed = createView(NoteDetailType, {
          idPrefix: 'detail', region: 'dynamic', name: 'Notes',
          render: () => {
            const current = ref('current', notes[0]!, noteRefOptions);
            const list = arrayRef('notes', notes, notesRefOptions);
            return {
              refs: [current, list], context: { inspect },
              body: [
                formatRef('Current note: First note', current), formatRef('All notes', list),
                ...notes.flatMap((note, index) => [formatRef(note.title, list, index), note.text]),
                '## Inspection', inspection,
              ].join('\n\n'),
            };
          },
        });
        opening = true;
        try {
          const result = prepareOpeningProjection({ views: [root, workspace, proposed] });
          if (result.status === 'rejected') return { success: false, error: { code: result.issue.code, message: result.issue.message } };
          detail = proposed;
        } finally { opening = false; }
      } else if (!want && detail) {
        detail = undefined;
        prepareProjection({ views: [root, workspace] });
      }
      return { success: true, data: { message: want ? 'Read Notes.' : 'Notes closed.' } };
    }
    prepareProjection({ views: [root, workspace] });
  },
});
