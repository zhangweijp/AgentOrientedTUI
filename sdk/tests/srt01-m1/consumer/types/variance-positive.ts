import { createToolBindings } from '@aotui/sdk';
import type { ArgsOf, ToolBindingController as RootController } from '@aotui/sdk';
import type { ToolBindingController, ToolSetMap } from '@aotui/sdk/tools';
import type { IAppTypeToolPort } from '@aotui/runtime/spi';
import { wideController, narrowController, wideSet, narrowSet, passWide, passNarrow } from './variance-producer.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type WideArgs = { readonly mode: 'append' | 'replace' };
type _Exact = Assert<Equal<ArgsOf<typeof wideSet.edit>, WideArgs>>;
type _NarrowExact = Assert<Equal<ArgsOf<typeof narrowSet.edit>, { readonly mode: 'append' }>>;
const sameMap: ToolBindingController<ToolSetMap<typeof wideSet>> = wideController;
const fromOtherModule = passWide(sameMap);
const rootSameMap: RootController<ToolSetMap<typeof wideSet>> = fromOtherModule;
rootSameMap.commit({ edit: { execute: args => {
  type _Args = Assert<Equal<typeof args, WideArgs>>;
  type _Any = Assert<Equal<IsAny<typeof args>, false>>;
  return { success: true, data: { mode: args.mode } };
} } });
passNarrow(narrowController).commit({ edit: { execute: args => {
  type _Args = Assert<Equal<typeof args, { readonly mode: 'append' }>>;
  type _Any = Assert<Equal<IsAny<typeof args>, false>>;
  return { success: true, data: { mode: args.mode } };
} } });
// A handler accepting a broader input remains safe; controller conversion is not needed.
narrowController.commit({ edit: { execute: (args: WideArgs) => ({ success: true, data: { mode: args.mode } }) } });
declare const port: IAppTypeToolPort;
const direct = createToolBindings({ definition: wideSet, appTypeTools: port });
direct.commit({ edit: { enabled: true, execute: args => {
  type _Args = Assert<Equal<typeof args, WideArgs>>;
  type _Any = Assert<Equal<IsAny<typeof args>, false>>;
  return { success: true, data: { mode: args.mode } };
} } });
