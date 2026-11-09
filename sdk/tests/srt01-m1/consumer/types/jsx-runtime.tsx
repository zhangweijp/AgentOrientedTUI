import { AppTools, ToolRef, ToolCatalog, View, createTUIApp, useState, useAppLifecycle } from '@aotui/sdk';
import { fileTools } from './m2-producer.js';
interface State { label: string; enabled: boolean; count: number }
let update: (state: State) => void = () => { throw new Error('Fixture not mounted'); };
let renders = 0, stops = 0, closes = 0;
function App() {
  const [state, setState] = useState<State>({ label: 'initial', enabled: true, count: 2 });
  update = setState; renders++;
  useAppLifecycle({ stop() { stops++; }, close() { closes++; } });
  return <AppTools definition={fileTools} bindings={{
    readFile: { enabled: state.enabled, execute: args => ({ success: true, data: { label: state.label, path: args.filePath } }) },
    editFile: { execute: args => ({ success: true, data: { mode: args.mode } }) },
  }}>
    <View kind="instruction" id="root" type="Root"><ToolCatalog definition={fileTools} /></View>
    {Array.from({ length: state.count }, (_, i) => <View kind="state" key={i} id={'file_' + i} type="FileDetail">
      <p>Current state: {state.label}</p><ToolRef tool={fileTools.readFile} />
    </View>)}
  </AppTools>;
}
export const factory: ReturnType<typeof createTUIApp> = createTUIApp({ app_name: 'jsx_fixture', component: App });
export const change = (state: State) => update(state);
export const facts = () => ({ renders, stops, closes });
