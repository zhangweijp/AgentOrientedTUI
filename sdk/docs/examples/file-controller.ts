import { createToolBindings } from '@aotui/sdk/tools';
import type { IAppTypeToolPort } from '@aotui/runtime/spi';
import { fileTools } from './file-tools.js';

type FileState = Readonly<{ viewId: string; content: string }>;
export type OpenedFiles = Readonly<Record<string, FileState>>;

// The existing Producer supplies its App port and publishes these business values as Views.
export function createFileController(appTypeTools: IAppTypeToolPort, onChange: (opened: OpenedFiles) => void) {
  const available = new Map<string, FileState>([
    ['a.txt', { viewId: 'file_a', content: 'Initial A' }],
    ['b.txt', { viewId: 'file_b', content: 'Initial B' }],
  ]);
  let opened: OpenedFiles = {};
  const controller = createToolBindings({ definition: fileTools, appTypeTools });
  function commit() {
    controller.commit({
      open: { execute: ({ filePath }) => {
        const file = available.get(filePath);
        if (!file) return { success: false, effects: 'none', error: { code: 'FILE_NOT_FOUND', message: 'Choose a.txt or b.txt.' } };
        opened = { ...opened, [filePath]: Object.hasOwn(opened, filePath) ? opened[filePath]! : { ...file } };
        commit();
        return { success: true, data: { message: 'Read the opened FileDetail View.' } };
      } },
      close: { enabled: Object.keys(opened).length > 0, execute: ({ filePath }) => {
        if (!Object.hasOwn(opened, filePath)) return { success: false, effects: 'none', error: { code: 'FILE_NOT_OPEN', message: 'This file is not open.' } };
        opened = Object.fromEntries(Object.entries(opened).filter(([path]) => path !== filePath));
        commit();
        return { success: true, data: { message: 'File closed.' } };
      } },
      edit: { enabled: Object.keys(opened).length > 0, execute: ({ filePath, content }) => {
        const file = Object.hasOwn(opened, filePath) ? opened[filePath] : undefined;
        if (!file) return { success: false, effects: 'none', error: { code: 'FILE_NOT_OPEN', message: 'Open this file before editing.' } };
        opened = { ...opened, [filePath]: { ...file, content } };
        commit();
        return { success: true, data: { message: 'Read the updated FileDetail View.' } };
      } },
    });
    onChange(opened);
  }
  commit();
  return { dispose: () => controller.dispose() };
}
