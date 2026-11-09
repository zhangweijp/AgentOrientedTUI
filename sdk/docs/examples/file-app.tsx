import {
  AppTools, ToolCatalog, View, createTUIApp, useState, type ToolBindings, type ToolSetMap,
} from '@aotui/sdk';
import { fileTools } from './file-tools.js';


type FileState = { viewId: string; content: string };
const available = new Map<string, FileState>([
  ['a.txt', { viewId: 'file_a', content: 'Initial A' }],
  ['b.txt', { viewId: 'file_b', content: 'Initial B' }],
]);

function AppRoot() {
  const [opened, setOpened] = useState<Record<string, FileState>>({});
  const bindings: ToolBindings<ToolSetMap<typeof fileTools>> = {
    open: { execute: ({ filePath }) => {
      const file = available.get(filePath);
      if (!file) return { success: false, effects: 'none', error: { code: 'FILE_NOT_FOUND', message: 'Choose a.txt or b.txt.' } };
      setOpened(current => current[filePath] ? current : { ...current, [filePath]: { ...file } });
      return { success: true, data: { message: 'Read the opened FileDetail View.' } };
    } },
    close: { enabled: Object.keys(opened).length > 0, execute: ({ filePath }) => {
      if (!Object.hasOwn(opened, filePath)) return { success: false, effects: 'none', error: { code: 'FILE_NOT_OPEN', message: 'This file is not open.' } };
      setOpened(current => Object.fromEntries(Object.entries(current).filter(([path]) => path !== filePath)));
      return { success: true, data: { message: 'File closed.' } };
    } },
    edit: { enabled: Object.keys(opened).length > 0, execute: ({ filePath, content }) => {
      const file = Object.hasOwn(opened, filePath) ? opened[filePath] : undefined;
      if (!file) return { success: false, effects: 'none', error: { code: 'FILE_NOT_OPEN', message: 'Open this file before editing.' } };
      setOpened(current => ({ ...current, [filePath]: { ...file, content } }));
      return { success: true, data: { message: 'Read the updated FileDetail View.' } };
    } },
  };
  return <AppTools definition={fileTools} bindings={bindings}>
    <View kind="instruction" id="root" type="Root" name="Demo instructions">
      <h1>File Demo Application Instruction</h1>
      <p>This in-memory demo opens a.txt and b.txt. It does not read or write disk. Closing discards edits; reopening restores the initial demo text.</p>
      <p>Use open_file from Workspace, then edit_file with the displayed filePath. Read content in FileDetail. close_file closes that page.</p>
      <ToolCatalog definition={fileTools} />
    </View>
    <View kind="state" id="workspace" type="Workspace" name="Workspace">
      <p>Available demo paths: a.txt, b.txt. FileDetail Views show opened files.</p>
    </View>
    {Object.entries(opened).map(([filePath, file]) => <View kind="state" key={filePath} id={file.viewId} type="FileDetail" name={filePath}>
      <p>filePath: {filePath}</p><pre>{file.content}</pre>
    </View>)}
  </AppTools>;
}

const app: ReturnType<typeof createTUIApp> = createTUIApp({ app_name: 'file_demo', component: AppRoot });
export default app;
