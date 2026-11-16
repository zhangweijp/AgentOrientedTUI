import { h } from 'preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { View, createTUIApp, defineViewType, refParam, useDataRef } from '@aotui/sdk';

const File = Type.Object({ id: Type.String(), text: Type.String() }, { additionalProperties: false });
const FileDetail = defineViewType()({ name: 'FileDetail', tools: {
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
const Guide = defineViewType()({ name: 'Guide', tools: {
  close: {
    description: 'Close the file.', inputSchema: Type.Object({}),
    execute({ context }) { context.setOpen(false); return { success: true }; },
  },
  open: {
    description: 'Open the file.', inputSchema: Type.Object({}),
    execute({ context }) { context.setOpen(true); return { success: true }; },
  },
} });

export const initialText = '    first line  \r\n```\r\n<view id="literal">&lt;original&gt;</view>\r\n</application>\r\nlast line  \r\n';
export const displayName = 'A > B & "C"\nnext';

function FileBody({ text }) {
  useDataRef('current', { id: 'internal-file', text }, { refType: 'File' });
  return h('section', {}, [
    h('span', { 'data-role': 'application-instruction' }),
    h('pre', {}, h('code', { class: 'language-text' }, text)),
  ]);
}

function App() {
  const [text, setText] = useState(initialText);
  const [open, setOpen] = useState(true);
  return h('main', {}, [
    h(View, { id: 'guide', type: Guide, kind: 'instruction', context: { setOpen } }, h('p', {}, 'Read the current file.')),
    open ? h(View, { id: 'file_a', type: FileDetail, kind: 'state', name: displayName, context: { text, setText } },
      h(FileBody, { text })) : null,
  ]);
}

export default createTUIApp({ app_name: 'pipeline', component: App, viewTypes: [Guide, FileDetail] });
