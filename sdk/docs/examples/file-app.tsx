import {
  ToolCatalog, View, createTUIApp, useAppRuntimeContext, useState, type ViewBindings,
} from '@aotui/sdk';
import { FileDetailType, fileViewTypes, RootType, WorkspaceType } from './file-tools.js';


type FileState = { viewId: string; content: string };
const available = new Map<string, FileState>([
  ['a.txt', { viewId: 'file_a', content: 'Initial A' }],
  ['b.txt', { viewId: 'file_b', content: 'Initial B' }],
]);

function FileDetail({ filePath, file }: { filePath: string; file: FileState }) {
  const { prepareProjection } = useAppRuntimeContext();
  const [content, setContent] = useState(file.content);
  return <View kind="state" id={file.viewId} type={FileDetailType} name={filePath} bindings={{
    edit_file: { async execute({ content: next }) {
      file.content = next;
      try {
        if (content !== next) await prepareProjection(() => setContent(file.content));
      } catch {
        return { success: true, data: { message: 'Edit applied. View refresh failed.' } };
      }
      return { success: true, data: { message: 'Read the updated FileDetail View.' } };
    } },
  }}>
    <p>filePath: {filePath}</p><pre>{content}</pre>
  </View>;
}

function AppRoot() {
  const { prepareProjection } = useAppRuntimeContext();
  const [opened, setOpened] = useState<Record<string, FileState>>({});
  const bindings: ViewBindings<typeof WorkspaceType> = {
    open_file: { async execute({ filePath }) {
      const file = available.get(filePath);
      if (!file) return { success: false, error: { code: 'FILE_NOT_FOUND', message: 'Choose a.txt or b.txt.' } };
      if (Object.hasOwn(opened, filePath)) return { success: true, data: { message: 'Read the open FileDetail View.' } };
      try {
        await prepareProjection(() => setOpened({ ...opened, [filePath]: { ...file } }), {
          revert: () => setOpened(opened),
        });
      } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'OBSERVATION_CAPACITY'
          ? { success: false, error: { code: error.code, message: error.message } }
          : { success: false, error: { code: 'VIEW_PREPARATION_FAILED', message: 'The FileDetail View could not be prepared.' } };
      }
      return { success: true, data: { message: 'Read the opened FileDetail View.' } };
    } },
    close_file: { enabled: Object.keys(opened).length > 0, execute: ({ filePath }) => {
      if (!Object.hasOwn(opened, filePath)) return { success: false, error: { code: 'FILE_NOT_OPEN', message: 'This file is not open.' } };
      setOpened(current => Object.fromEntries(Object.entries(current).filter(([path]) => path !== filePath)));
      return { success: true, data: { message: 'File closed.' } };
    } },
  };
  return <>
    <View kind="instruction" id="root" type={RootType} name="Demo instructions">
      <h1>File Demo Application Instruction</h1>
      <p>This in-memory demo opens a.txt and b.txt. It does not read or write disk. Closing discards edits; reopening restores the initial demo text.</p>
      <p>Pass view_id=workspace to open_file or close_file with a filePath. To edit a file, pass its FileDetail XML id to edit_file and read the updated page.</p>
      <ToolCatalog viewTypes={fileViewTypes} />
    </View>
    <View kind="state" id="workspace" type={WorkspaceType} bindings={bindings} name="Workspace">
      <p>Available demo paths: a.txt, b.txt. FileDetail Views show opened files.</p>
    </View>
    {Object.entries(opened).map(([filePath, file]) => <FileDetail key={filePath} filePath={filePath} file={file} />)}
  </>;
}

const app: ReturnType<typeof createTUIApp> = createTUIApp({ app_name: 'file_demo', component: AppRoot, viewTypes: fileViewTypes });
export default app;
