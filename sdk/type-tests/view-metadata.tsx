import { View, defineViewType } from '../src/index.js';

const Empty = defineViewType({ name:'Empty' });
export const instruction = <View id="guide" type={Empty} kind="instruction" />;
export const state = <View id="file_a" type={Empty} kind="state" />;
// @ts-expect-error ViewType is required independently of instance ID.
export const noType = <View id="file_a" kind="state" />;
// @ts-expect-error Purpose is required independently of body content.
export const noKind = <View id="file_a" type={Empty} />;
// @ts-expect-error Purpose has exactly the two existing snapshot values.
export const badKind = <View id="file_a" type={Empty} kind="application-instruction" />;
