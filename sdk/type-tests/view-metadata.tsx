import { StaticView, DynamicView, defineViewType } from '@aotui/sdk';

const Guide = defineViewType({ name: 'Guide', multiplicity: 'single', region: 'static' });
const Detail = defineViewType({ name: 'Detail', multiplicity: 'multiple' });

export const instructions = <Guide id="instructions" />;
export const current = <Guide region="dynamic" />;
export const report = <Detail idPrefix="report" region="dynamic" />;
export const summary = <StaticView idPrefix="summary" type={Detail} />;
export const session = <DynamicView id="session" type={Guide} />;
// @ts-expect-error A ViewType without a region requires a region in direct JSX.
export const noRegion = <Detail />;
// @ts-expect-error Multiple pages choose an ID by prefix or the type's createId.
export const multipleId = <DynamicView id="report" type={Detail} />;
// @ts-expect-error Single pages may supply an ID, but do not take a prefix.
export const singlePrefix = <Guide idPrefix="instructions" />;
// @ts-expect-error The wrapper supplies its own region.
export const wrapperRegion = <StaticView type={Guide} region="dynamic" />;
// @ts-expect-error The wrapper needs a declared ViewType.
export const noType = <DynamicView idPrefix="file" />;
