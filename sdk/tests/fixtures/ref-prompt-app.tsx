import Type from 'typebox';
import { createTUIApp, defineViewType, refParam, useArrayRef, useDataRef, useState, DynamicView,
  type ArrayRefHandle, type ItemRefFormatter } from '@aotui/sdk';

const File = Type.Object({ path: Type.String() });
const Task = Type.Object({ name: Type.String() });
const files = [{ path: 'dir/a.txt' }, { path: 'dir/b.txt' }];
const refOptions = { scope: 'protected' as const, itemType: 'File', schema: Type.Array(File) };
const description = 'Choose the source.';
const target = <S extends Type.TSchema>(refType: string, schema: S) =>
  Object.assign(refParam(refType, schema), { description });

const List = defineViewType({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'List' });
const Editor = defineViewType<{ enabled: boolean; record(value: string): void; reverse(): void }>()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix,
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

function InlineWordRows({ item }: { item: ItemRefFormatter }) {
  return <>
    <li><span>{'Open '}</span><span>file</span></li>
    <li><span>Open</span><span>{' file'}</span></li>
    <li><strong>Status:</strong><span>{' ready'}</span></li>
    <li><span>pass</span><span>word</span></li>
    <li><span><small>{'Nested '}</small></span><span>file</span></li>
    <li><span>State</span><em>{' ready '}</em><span>now</span></li>
    <li><em><span>pass</span><span>word</span></em></li>
    <li><a href="#editor">{'Open '}</a><span>editor</span></li>
    <li><span>{'Move '}</span><code>{' say ` hi '}</code><span>{' to '}{item(0, 'inline ref')}</span></li>
  </>;
}

function FilesRows({ refs: [all, item] }: { refs: ArrayRefHandle }) {
  const file = 'test.txt';
  const editor = 'editor';
  const type = 'FileDetail';
  const tools = ['edit', 'close'];
  const status = 'ready';
  return <ul>
    <li>{file} — View {editor}</li>
    <li>{type}: {tools.join(', ')}</li>
    <li><strong>Status:</strong> {status}</li>
    <li>{'pass'}{'word'}</li>
    <li>Open {item(0, 'label')} &amp; <code>{' say ` hi '}</code>
      <ol><li>{'pass'}{'word'}</li><li><em>Choose</em> {item(1, 'other file')}</li></ol>
    </li>
    <li>{all('all files')}</li>
    <InlineWordRows item={item} />
    <li>Inline boundaries<ol><InlineWordRows item={item} /></ol></li>
  </ul>;
}

function FilesContent({ entries }: { entries: typeof files }) {
  const refs = useArrayRef('items', entries, refOptions);
  return <FilesRows refs={refs} />;
}

function FilesPage({ entries }: { entries: typeof files }) {
  return <DynamicView idPrefix="files" type={List} ><FilesContent entries={entries} /></DynamicView>;
}

function BrokenFilesPage({ entries }: { entries: typeof files }) {
  const refs = useArrayRef('items', entries, refOptions);
  return <DynamicView idPrefix="files" type={List} >
    <FilesRows refs={refs} />
  </DynamicView>;
}

function TaskContent() {
  const item = useDataRef('items', { name: 'review task' }, { scope: 'protected', refType: 'Task', schema: Task });
  return <p>{item('review task')}</p>;
}

export function refPromptApp(Page = FilesPage) {
  function App() {
    const [entries, setEntries] = useState(files);
    const [actions, setActions] = useState<string[]>([]);
    const context = {
      enabled: true,
      record(value: string) { setActions(current => [...current, value]); },
      reverse() { setEntries(current => [...current].reverse()); },
    };
    return <>
      <Page entries={entries} />
      <DynamicView idPrefix="tasks" type={List} ><TaskContent /></DynamicView>
      <DynamicView idPrefix="editor" type={Editor}  context={context}><pre>{JSON.stringify(actions)}</pre></DynamicView>
      <DynamicView idPrefix="read_only" type={Editor}  context={{ ...context, enabled: false }}>Read only</DynamicView>
    </>;
  }
  return createTUIApp({ app_name: 'refs', component: App, viewTypes });
}

export const broken = refPromptApp(BrokenFilesPage);
export default refPromptApp();
