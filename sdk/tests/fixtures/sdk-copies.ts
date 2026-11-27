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
    initialize({ appId, launchConfig, publish: commit }) {
      let selected = 'none';
      const page = (() => { const handle = createView(Page, { id: 'detail' }); return { handle, frame: () => {
          const value = (mode === 'explicit' ? copyRef : ref)('value', String(launchConfig?.word), {
            scope: 'private', refType: 'CopyValue', schema: Type.String(),
          });
          return handle.frame({ refs: [value], body: appId + ' ' + formatRef('Select', value) + '\n\nSelected ' + selected, context: { select(next: string) { selected = next; commit(() => ([page]).map(page => page.frame())); } } });
        } }; })();
      commit(() => ([page]).map(page => page.frame()));
    },
  });
}
