import Type from 'typebox';
import { createApp, createView, defineViewType, refParam, ref } from '@aotui/sdk';

const File = Type.Object({ id: Type.String(), text: Type.String() }, { additionalProperties: false });
const FileDetail = defineViewType()({ multiplicity: 'multiple', name: 'FileDetail', tools: {
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

export default createApp({
  app_name: 'pipeline', viewTypes: [Guide, FileDetail, Note, Status],
  initialize({ prepareProjection, prepareOpeningProjection }) {
    let text = initialText;
    let pinned = false, opening = false;
    const guide = createView(Guide, { id: 'guide', render: () => ({
      body: '\nRead the current file.\n', context: { setOpen, toggleStatic },
    }) });
    const note = createView(Note, { idPrefix: 'note', region: 'static', render: () => ({ body: 'Other static guidance.' }) });
    const status = createView(Status, { id: 'status', region: 'dynamic', render: () => ({ body: file || opening ? 'Open' : 'Closed' }) });
    function makeFile(region) {
      return createView(FileDetail, { idPrefix: 'file_a', region, name: displayName, render: () => {
        const current = ref('current', { id: 'internal-file', text }, { schema: File, scope: 'protected', refType: 'File' });
        let length = 3;
        for (const run of text.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
        const fence = '`'.repeat(length);
        return { body: '\n' + fence + 'text\n' + text + (text.endsWith('\n') ? '' : '\n') + fence + '\n',
            refs: [current], context: { text, setText(next) { text = next; publish(); } } };
      } });
    }
    let file = makeFile('dynamic');
    const frame = (view) => ({ views: [guide, note, status, ...(view ? [view] : [])] });
    function publish() { prepareProjection(frame(file)); }
    function show(next) {
      opening = true;
      try {
        const result = prepareOpeningProjection(frame(next));
        if (result.status === 'rejected') throw Error(result.issue.message);
        file = next;
      } finally { opening = false; }
    }
    function setOpen(open) {
      if (open && !file) show(makeFile(pinned ? 'static' : 'dynamic'));
      if (!open && file) { file = undefined; publish(); }
    }
    function toggleStatic() {
      if (file) show(makeFile(pinned ? 'dynamic' : 'static'));
      pinned = !pinned;
    }
    publish();
  },
});
