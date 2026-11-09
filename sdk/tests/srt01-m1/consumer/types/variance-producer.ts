import Type from 'typebox';
import { createToolBindings, defineToolSet, defineViewTypeTool } from '@aotui/sdk/tools';
import type { ToolBindingController, ToolSetMap } from '@aotui/sdk/tools';
import type { IAppTypeToolPort } from '@aotui/runtime/spi';
declare const port: IAppTypeToolPort;
export const wideSet = defineToolSet({ edit: defineViewTypeTool({
  viewType: 'File', name: 'edit', description: 'Edit.',
  inputSchema: Type.Object({ mode: Type.Enum(['append', 'replace']) }),
}) });
export const narrowSet = defineToolSet({ edit: defineViewTypeTool({
  viewType: 'File', name: 'edit', description: 'Edit.',
  inputSchema: Type.Object({ mode: Type.Enum(['append']) }),
}) });
export type WideMap = ToolSetMap<typeof wideSet>;
export type NarrowMap = ToolSetMap<typeof narrowSet>;
export const wideController = createToolBindings({ definition: wideSet, appTypeTools: port });
export const narrowController = createToolBindings({ definition: narrowSet, appTypeTools: port });
export function passWide(controller: ToolBindingController<WideMap>): ToolBindingController<WideMap> { return controller; }
export function passNarrow(controller: ToolBindingController<NarrowMap>): ToolBindingController<NarrowMap> { return controller; }
