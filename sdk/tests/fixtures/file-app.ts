import { createApp, createView, type ToolResult, type ViewHandle } from '@aotui/sdk';
import { FileDetailType, fileViewTypes, RootType, WorkspaceType } from './file-tools.js';

const initial = new Map([
  ['a.txt', { prefix: 'file_a', text: 'Initial A' }],
  ['b.txt', { prefix: 'file_b', text: 'Initial B' }],
]);

export default createApp({
  app_name: 'file_demo', viewTypes: fileViewTypes,
  initialize({ prepareProjection, prepareOpeningProjection }) {
    let files = new Map<string, ViewHandle>();
    let candidate: Map<string, ViewHandle> | undefined;
    const root = createView(RootType, {
      idPrefix: 'root', name: 'Demo instructions', region: 'static',
      render: () => ({ body: [
        '# File Demo Application Instruction',
        'This in-memory demo opens a.txt and b.txt. Closing discards edits; reopening restores the initial demo text.',
        'Pass the Workspace XML view_id to open_file or close_file with a filePath. To edit a file, pass its FileDetail XML id to edit_file and read the updated page.',
      ].join('\n\n') }),
    });
    const workspace = createView(WorkspaceType, {
      idPrefix: 'workspace', name: 'Workspace', region: 'dynamic',
      render: () => ({
        body: 'Available demo paths: a.txt, b.txt. FileDetail Views show opened files.\n\nOpen: ' +
          ([...(candidate ?? files).keys()].join(', ') || 'none'),
        context: { hasOpenFiles: Boolean((candidate ?? files).size), openFile, closeFile },
      }),
    });
    const frame = (opened: Map<string, ViewHandle>) => ({ views: [root, workspace, ...opened.values()] });
    async function openFile(path: string): Promise<ToolResult> {
      const file = initial.get(path);
      if (!file) return { success: false, error: { code: 'FILE_NOT_FOUND', message: 'Choose a.txt or b.txt.' } };
      if (files.has(path)) return { success: true, data: { message: 'Read the open FileDetail View.' } };
      let text = file.text;
      const handle = createView(FileDetailType, { idPrefix: file.prefix, name: path, region: 'dynamic',
        render: () => ({
          body: 'filePath: ' + path + '\n\n' + text,
          context: { async edit(next) {
            text = next;
            try { prepareProjection(frame(files)); }
            catch { return { success: true, data: { message: 'Edit applied. View refresh failed.' } }; }
            return { success: true, data: { message: 'Read the updated FileDetail View.' } };
          } },
        }),
      });
      const next = new Map(files).set(path, handle);
      candidate = next;
      try {
        const result = prepareOpeningProjection(frame(next));
        if (result.status === 'rejected') return { success: false, error: { code: result.issue.code, message: result.issue.message } };
        files = next;
        return { success: true, data: { message: 'Read the opened FileDetail View.' } };
      } finally { candidate = undefined; }
    }
    function closeFile(path: string): ToolResult {
      if (!files.delete(path)) return { success: false, error: { code: 'FILE_NOT_OPEN', message: 'This file is not open.' } };
      prepareProjection(frame(files));
      return { success: true, data: { message: 'File closed.' } };
    }
    prepareProjection(frame(files));
  },
});
