import Type from 'typebox';
import { createApp, createView, defineViewType, formatRef, ref, refParam } from '@aotui/sdk';
import { defineViewType as defineInCopy, ref as copyRef } from '@aotui/sdk-copy';

function declareFile(define: typeof defineViewType, name = 'file') {
  return define<{ select(value: string): void }>()({
    name, multiplicity: 'single', region: 'dynamic',
    tools: {
      choose: {
        description: 'Choose the value published by the file page.',
        inputSchema: Type.Object({ value: refParam('CopyValue', Type.String()) }, { additionalProperties: false }),
        execute({ input, context }) {
          context.select(input.value);
          return { success: true };
        },
      },
    },
  });
}

const Local = declareFile(defineViewType);
const Foreign = declareFile(defineInCopy);
const SameName = declareFile(defineInCopy);
const OtherName = declareFile(defineInCopy, 'other');

export function copyApp(mode: 'local' | 'direct' | 'explicit' | 'same-name' | 'other-name') {
  const Registered = mode === 'local' ? Local : Foreign;
  const Page = mode === 'same-name' ? SameName : mode === 'other-name' ? OtherName : Registered;
  return createApp({
    app_name: 'copy_views', viewTypes: [Registered],
    initialize({ appId, launchConfig, prepareProjection }) {
      let selected = 'none';
      const page = createView(Page, {
        id: 'detail',
        render: () => {
          const value = (mode === 'explicit' ? copyRef : ref)('value', String(launchConfig?.word), {
            scope: 'private', refType: 'CopyValue', schema: Type.String(),
          });
          return {
            refs: [value],
            body: appId + ' ' + formatRef('Select', value) + '\n\nSelected ' + selected,
            context: { select(next: string) { selected = next; prepareProjection({ views: [page] }); } },
          };
        },
      });
      prepareProjection({ views: [page] });
    },
  });
}
