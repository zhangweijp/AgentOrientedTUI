import Type from 'typebox';
import { createApp, createView, defineViewType, formatRef, ref, refParam } from '@aotui/sdk';

const FileSchema = Type.Object({ filePath: Type.String(), text: Type.String() }, { additionalProperties: false });
const Guide = defineViewType({ multiplicity: 'multiple', name: 'Root' });
const FileDetail = defineViewType()({ multiplicity: 'multiple', name: 'Detail', tools: {
  ordinary: {
    description: 'Apply text to the selected file. Read the updated Detail.',
    inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    async execute({ input, context: { edit } }) {
      edit(input.text);
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

export default createApp({ app_name: 'interaction_example', viewTypes,
  initialize({ prepareProjection }) {
    let count = 0, text = 'original';
    const filePath = '/open/note.txt';
    const root = createView(Guide, { idPrefix: 'root', region: 'static', render: () => ({
      body: '# File Application Instruction\n\nSelect the receiving View by view_id. Use the published File Ref address.',
    }) });
    const detail = createView(FileDetail, { idPrefix: 'detail', region: 'dynamic', render: () => {
      const file = ref('file', { filePath, text }, { scope: 'protected', refType: 'File', schema: FileSchema });
      return { refs: [file], body: ['Open file: ' + filePath, formatRef('Current file value', file), text, 'Completed actions: ' + count].join('\n\n'),
        context: { filePath, edit(value) { text = value; count++; publish(); } } };
    } });
    function publish() { prepareProjection({ views: [root, detail] }); }
    publish();
  },
});
