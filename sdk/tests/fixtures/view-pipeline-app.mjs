import { h } from 'preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { StaticView, DynamicView, createTUIApp, defineViewType, refParam, useDataRef } from '@aotui/sdk';

const File = Type.Object({ id: Type.String(), text: Type.String() }, { additionalProperties: false });
const FileDetail = defineViewType()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'FileDetail', tools: {
  update: {
    description: 'Update the displayed text.',
    inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    execute({ input, context }) { context.setText(input.text); return { success: true }; },
  },
  inspect: {
    description: 'Inspect a displayed File Ref.',
    inputSchema: Type.Object({ file: refParam('File', File) }, { additionalProperties: false }),
    execute: ({ input, context }) => ({ success: true, data: { matches: input.file.text === context.text } }),
  },
} });
const Guide = defineViewType()({ name: 'Guide', multiplicity: 'single', region: 'static', tools: {
  close: {
    description: 'Close the file.', inputSchema: Type.Object({}),
    execute({ context }) { context.setOpen(false); return { success: true }; },
  },
  open: {
    description: 'Open the file.', inputSchema: Type.Object({}),
    execute({ context }) { context.setOpen(true); return { success: true }; },
  },
  move: {
    description: 'Move the file page to or from the static region.',
    execute({ context }) { context.toggleStatic(); return { success: true }; },
  },
} });
const Note = defineViewType({ name: 'Note', multiplicity: 'multiple' });
const Status = defineViewType({ name: 'Status', multiplicity: 'single' });

export const initialText = '    first line  \r\n```\r\n<view id="literal">&lt;original&gt;</view>\r\n</application>\r\nlast line  \r\n';
export const displayName = 'A > B & "C"\nnext';

function FileBody({ text }) {
  useDataRef('current', { id: 'internal-file', text }, { scope: 'protected', refType: 'File' });
  return h('section', {}, [
    h('span', { 'data-role': 'application-instruction' }),
    h('pre', {}, h('code', { class: 'language-text' }, text)),
  ]);
}

function App() {
  const [text, setText] = useState(initialText);
  const [open, setOpen] = useState(true);
  const [pinned, setPinned] = useState(false);
  return h('main', {}, [
    h(Guide, { id: 'guide', context: { setOpen, toggleStatic: () => setPinned(value => !value) } },
      h('p', {}, 'Read the current file.')),
    h(StaticView, { type: Note, idPrefix: 'note' }, 'Other static guidance.'),
    h(DynamicView, { type: Status, id: 'status' }, open ? 'Open' : 'Closed'),
    open ? h(FileDetail, { idPrefix: 'file_a', region: pinned ? 'static' : 'dynamic', name: displayName, context: { text, setText } },
      h(FileBody, { text })) : null,
  ]);
}

export default createTUIApp({ app_name: 'pipeline', component: App, viewTypes: [Guide, FileDetail, Note, Status] });
