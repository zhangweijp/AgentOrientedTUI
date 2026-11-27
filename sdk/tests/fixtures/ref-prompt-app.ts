import Type from 'typebox';
import { arrayRef, createApp, createView, defineViewType, formatRef, ref, refParam } from '@aotui/sdk';

const File = Type.Object({ path: Type.String() });
const Task = Type.Object({ name: Type.String() });
const files = [{ path: 'dir/a.txt' }, { path: 'dir/b.txt' }];
const refOptions = { scope: 'protected' as const, itemType: 'File', schema: Type.Array(File) };
const description = 'Choose the source.';
const target = <S extends Parameters<typeof refParam>[1]>(refType: string, schema: S) =>
  Object.assign(refParam(refType, schema), { description });

const List = defineViewType({ multiplicity: 'multiple', name: 'List' });
const Editor = defineViewType<{ enabled: boolean; record(value: string): void; reverse(): void }>()({ multiplicity: 'multiple',
  name: 'Editor',
  tools: {
    select_file: {
      description, inputSchema: Type.Object({ target: target('File', File) }),
      enabled: context => context.enabled,
      execute({ input, context }) { context.record(input.target.path); return { success: true }; },
    },
    select_task: {
      description, inputSchema: Type.Object({ target: target('Task', Task) }),
      enabled: context => context.enabled,
      execute({ input, context }) { context.record(input.target.name); return { success: true }; },
    },
    select_all: {
      description, inputSchema: Type.Object({ target: target('File', Type.Array(File)) }),
      enabled: context => context.enabled,
      execute({ input, context }) { context.record(input.target.map(file => file.path).join(',')); return { success: true }; },
    },
    select_many: {
      description,
      inputSchema: Type.Object({
        target: Type.Optional(Type.Array(target('File', File), { description })),
        path: Type.String(),
        text: Type.String(),
      }),
      enabled: context => context.enabled,
      execute({ input, context }) {
        context.record(JSON.stringify([input.target?.map(file => file.path) ?? null, input.path, input.text]));
        return { success: true };
      },
    },
    reverse: {
      description: 'Reverse the file list.',
      enabled: context => context.enabled,
      execute({ context }) { context.reverse(); return { success: true }; },
    },
  },
});
export const viewTypes = [List, Editor];

export function refPromptApp(refId = 'items') {
  return createApp({
    app_name: 'refs', viewTypes,
    initialize({ publish: commit }) {
      let entries = files;
      let actions: string[] = [];
      const context = {
        enabled: true,
        record(value: string) { actions = [...actions, value]; publish(); },
        reverse() { entries = [...entries].reverse(); publish(); },
      };
      const list = (() => { const handle = createView(List, { idPrefix: 'files', region: 'dynamic' }); return { handle, frame: () => {
          const items = arrayRef(refId, entries, refOptions);
          const first = formatRef('label', items, 0), second = formatRef('other file', items, 1);
          const rows = ['Open file', 'Open file', '**Status:** ready', 'password', 'Nested file', 'State *ready* now',
            '*password*', '[Open](#editor) editor', 'Move ``  say ` hi  `` to ' + formatRef('inline ref', items, 0)];
          return handle.frame({ refs: [items], body: [
            '- test.txt — View editor', '- FileDetail: edit, close', '- **Status:** ready', '- password',
            '- Open ' + first + ' & ``  say ` hi  ``', '    1. password', '    2. *Choose* ' + second,
            '- ' + formatRef('all files', items), ...rows.map(row => '- ' + row),
            '- Inline boundaries', ...rows.map((row, i) => '    ' + (i + 1) + '. ' + row),
          ].join('\n') + '\n' });
        } }; })();
      const tasks = (() => { const handle = createView(List, { idPrefix: 'tasks', region: 'dynamic' }); return { handle, frame: () => {
          const item = ref('items', { name: 'review task' }, { scope: 'protected', refType: 'Task', schema: Task });
          return handle.frame({ body: formatRef('review task', item), refs: [item] });
        } }; })();
      const editor = (() => { const handle = createView(Editor, { idPrefix: 'editor', region: 'dynamic' }); return { handle, frame: () => handle.frame({ body: JSON.stringify(actions), context }) }; })();
      const readOnly = (() => { const handle = createView(Editor, { idPrefix: 'read_only', region: 'dynamic' }); return { handle, frame: () => handle.frame({ body: 'Read only', context: { ...context, enabled: false } }) }; })();
      function publish() { commit(() => ([list, tasks, editor, readOnly]).map(page => page.frame())); }
      publish();
    },
  });
}

export const broken = refPromptApp('items.0');
export default refPromptApp();
