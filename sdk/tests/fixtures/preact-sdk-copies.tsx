import Type from 'typebox';
import { createTUIApp, defineViewType, DynamicView, refParam, useAppRuntimeContext, useDataRef, useState } from '@aotui/sdk';
import { defineViewType as defineInCopy, useAppRuntimeContext as useCopyApp, useDataRef as useCopyRef } from '@aotui/sdk-copy';

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

function FileBody({ useApp, useRef, selected }: {
  useApp: typeof useAppRuntimeContext; useRef: typeof useDataRef; selected: string;
}) {
  const { appId, launchConfig } = useApp();
  const value = useRef('value', String(launchConfig?.word), { scope: 'private', refType: 'CopyValue', schema: Type.String() });
  return <><p>{appId} {value('Select')}</p><p>Selected {selected}</p></>;
}

export function copyApp(mode: 'local' | 'direct' | 'explicit' | 'same-name' | 'other-name') {
  const Registered = mode === 'local' ? Local : Foreign;
  const Page = mode === 'same-name' ? SameName : mode === 'other-name' ? OtherName : Registered;
  function Root() {
    const [selected, select] = useState('none');
    const props = { id: 'detail', context: { select } };
    const body = <FileBody selected={selected}
      useApp={mode === 'explicit' ? useCopyApp : useAppRuntimeContext}
      useRef={mode === 'explicit' ? useCopyRef : useDataRef} />;
    return mode === 'explicit'
      ? <DynamicView type={Registered} {...props}>{body}</DynamicView>
      : <Page {...props}>{body}</Page>;
  }
  return createTUIApp({ app_name: 'copy_views', viewTypes: [Registered], component: Root });
}
