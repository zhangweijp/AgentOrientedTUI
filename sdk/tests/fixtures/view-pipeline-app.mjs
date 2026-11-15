import { h } from 'preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { View, createTUIApp, defineViewType, refParam, useDataRef } from '@aotui/sdk';

const File = Type.Object({ id: Type.String(), text: Type.String() }, { additionalProperties: false });
const FileDetail = defineViewType({ name: 'FileDetail', tools: {
  update: { description: 'Update the displayed text.',
    inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }) },
  inspect: { description: 'Inspect a displayed File Ref.',
    inputSchema: Type.Object({ file: refParam('File', File) }, { additionalProperties: false }) },
} });
const Guide = defineViewType({ name: 'Guide', tools: {
  close: { description: 'Close the file.', inputSchema: Type.Object({}) },
  open: { description: 'Open the file.', inputSchema: Type.Object({}) },
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
    h(View, { id: 'guide', type: Guide, kind: 'instruction', bindings: {
      close: { execute: () => { setOpen(false); return { success: true }; } },
      open: { execute: () => { setOpen(true); return { success: true }; } },
    } }, h('p', {}, 'Read the current file.')),
    open ? h(View, { id: 'file_a', type: FileDetail, kind: 'state', name: displayName, bindings: {
      update: { execute: ({ text: value }) => { setText(value); return { success: true }; } },
      inspect: { execute: ({ file }) => ({ success: true, data: { matches: file.text === text } }) },
    } }, h(FileBody, { text })) : null,
  ]);
}

export default createTUIApp({ app_name: 'pipeline', component: App, viewTypes: [Guide, FileDetail] });
