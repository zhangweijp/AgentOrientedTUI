import { createView, defineViewType } from '@aotui/sdk';

const Guide = defineViewType({ name: 'Guide', multiplicity: 'single', region: 'static' });
const Detail = defineViewType({ name: 'Detail', multiplicity: 'multiple' });
const render = () => ({ body: 'Hello' });

export const instructions = createView(Guide, { id: 'instructions', render });
export const current = createView(Guide, { region: 'dynamic', render: () => ({ name: 'Current', body: 'Hello' }) });
export const report = createView(Detail, { idPrefix: 'report', region: 'dynamic', render });
// @ts-expect-error A ViewType without a default requires a region on the handle.
export const noRegion = createView(Detail, { render });
// @ts-expect-error A multiple ViewType accepts a prefix instead of a fixed routing ID.
export const multipleId = createView(Detail, { id: 'report', region: 'dynamic', render });
// @ts-expect-error A single ViewType accepts a fixed routing ID.
export const singlePrefix = createView(Guide, { idPrefix: 'instructions', render });
