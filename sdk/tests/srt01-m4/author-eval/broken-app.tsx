import Type from 'typebox';
import { AppTools, ToolRef, ToolCatalog, View, createTUIApp, defineToolSet, defineViewTypeTool, useState } from '@aotui/sdk';
const rename = defineViewTypeTool({ viewType: 'Record', name: 'rename', description: 'Uppercase the current record code.',
  inputSchema: Type.Object({ code: Type.Number() }, { additionalProperties: false }) });
export const repairTools = defineToolSet({ rename, accidentalDuplicate: rename });
function Root() {
  const [code, setCode] = useState('INITIAL_RECORD');
  void setCode;
  return <AppTools definition={repairTools} bindings={{}}>
    <View kind="state" id="record" type="Record"><pre>{code}</pre><ToolRef tool={rename} /><ToolCatalog definition={repairTools} /></View>
  </AppTools>;
}
const app: ReturnType<typeof createTUIApp> = createTUIApp({ app_name: 'record_repair', component: Root });
export default app;
