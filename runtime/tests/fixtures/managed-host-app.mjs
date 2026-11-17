import { h } from 'preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { ToolCatalog, createTUIApp, defineViewType, refParam, View, useDataRef } from '@aotui/sdk';

const FileSchema = Type.Object({ filePath: Type.String(), text: Type.String() }, { additionalProperties: false });
const Guide = defineViewType({ name: 'Root' });
const FileDetail = defineViewType()({ name: 'Detail', tools: {
  ordinary: {
    description: 'Apply text to the selected file. Read the updated Detail.',
    inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    async execute({ input, context: { setText, setCount } }) {
      setText(input.text);
      setCount(current => current + 1);
      return { success: true, data: { message: 'Change completed.' } };
    },
  },
  ref: {
    description: 'Inspect the displayed File Ref.',
    inputSchema: Type.Object({ file: refParam('File', FileSchema) }, { additionalProperties: false }),
    async execute({ input, context }) {
      if (input.file.filePath !== context.filePath) return { success: false,
        error: { code: 'REF_WRONG_FILE', message: 'Select the displayed file.' } };
      return { success: true, data: { currentValueAvailable: true } };
    },
  },
} });
const viewTypes = [Guide, FileDetail];

function FileBody({ count, text, filePath }) {
  const file = useDataRef('file', { filePath, text }, { refType: 'File' });
  return h('section', {}, h('p', {}, 'Open file: ' + filePath), h('p', {}, file('Current file value')), h('pre', {}, text),
    h('p', {}, 'Completed actions: ' + count));
}
function Detail({ id, filePath }) {
  const [count, setCount] = useState(0), [text, setText] = useState('original');
  return h(View, { kind: 'state', id, type: FileDetail, context: { filePath, setText, setCount } },
    h(FileBody, { count, text, filePath }));
}
function Root() {
  return h('main', {}, [
    h(View, { kind: 'instruction', id: 'root', type: Guide }, h('section', {},
      h('h1', {}, 'File Application Instruction'),
      h('p', {}, 'Select the receiving View by XML id. For a File Ref, combine its View id and local name (detail.file).'),
      h(ToolCatalog, { viewTypes }))),
    h(Detail, { id: 'detail', filePath: '/open/note.txt' }),
  ]);
}
export default createTUIApp({ app_name: 'interaction_example', viewTypes, component: Root });
