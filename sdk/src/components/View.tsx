import type { AppFrameBinding, MountedView } from '@aotui/runtime/spi';
import { type ComponentChildren, type JSX, h } from 'preact';
import { useContext, useLayoutEffect, useMemo } from 'preact/hooks';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import { ViewRuntimeContext } from '../contexts/view-runtime-context.js';
import { VIEW_ID_PATTERN } from '../app-factory/app-factory.js';
import { captureViewBindings, requireViewType, type ViewBindingProps, type ViewType } from '../tools/view-type-tool.js';

export type ViewProps<Definition extends ViewType = ViewType> = {
  readonly id: string;
  readonly type: Definition;
  readonly kind: 'instruction' | 'state';
  readonly name?: string;
  readonly children?: ComponentChildren;
} & ViewBindingProps<NoInfer<Definition>>;

export function View<const Definition extends ViewType>({ id, type, kind, name, bindings, context, children }: ViewProps<Definition>): JSX.Element {
  if (typeof id !== 'string' || !VIEW_ID_PATTERN.test(id))
    throw new Error('[AOTUI SDK] View IDs must use only ASCII letters, digits or underscores');
  if (kind !== 'instruction' && kind !== 'state')
    throw new TypeError('[AOTUI SDK] VIEW_METADATA_INVALID: View requires kind="instruction" or kind="state".');

  const parent = useContext(ViewRuntimeContext);
  if (parent) {
    throw Object.assign(new Error(
      `NESTED_VIEW_UNSUPPORTED: View "${id}" cannot be declared inside View "${parent.viewId}". Declare independent sibling Views.`,
    ), { code: 'NESTED_VIEW_UNSUPPORTED', parentViewId: parent.viewId, childViewId: id });
  }
  const app = useContext(AppRuntimeContext);
  if (!app) throw new Error('[AOTUI SDK] View requires a managed App');
  const definition = requireViewType(app.viewTypes, type);

  const next = captureViewBindings(definition, bindings, id, context);
  const slot = useMemo(() => {
    let attached: { node: HTMLDivElement; mount: MountedView } | undefined;
    return {
      attach(node: HTMLDivElement | null) {
        if (!node && attached) {
          if (app.views.get(attached.node)?.owner === attached.mount.owner) app.views.delete(attached.node);
          attached.mount.release();
          attached = undefined;
        } else if (node) {
          attached = { node, mount: app.mountView(id, definition.name) };
        }
      },
      update(nextBindings: readonly AppFrameBinding[]) {
        if (!attached) throw new Error('View commit requires a DOM attachment');
        app.views.set(attached.node, { id, type: definition.name, owner: attached.mount.owner, bindings: nextBindings });
      },
      refs: {
        viewId: id,
        captureRef: app.refExporter.captureRef.bind(app.refExporter),
        registerRef: (...args: Parameters<MountedView['registerRef']>) => {
          if (!attached) throw new Error('Ref registration requires a DOM attachment');
          return attached.mount.registerRef(...args);
        },
      },
    };
  }, [app, id, definition]);
  useLayoutEffect(() => { slot.update(next); });

  return h(ViewRuntimeContext.Provider, { value: slot.refs }, h('div', {
    ref: slot.attach, id, 'data-view-id': id, 'data-view-type': definition.name,
    'data-view-kind': kind, 'data-view-name': name ?? id,
  }, children));
}
