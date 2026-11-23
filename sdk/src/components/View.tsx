import type { AppFrameBinding, AppFrameView } from '@aotui/core';
import type { ViewMultiplicity, ViewRegion } from '@aotui/core';
import { type ComponentChildren, type JSX, h } from 'preact';
import { useContext, useLayoutEffect, useMemo } from 'preact/hooks';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import { ViewRuntimeContext } from '../contexts/view-runtime-context.js';
import {
  defineViewType as defineDescriptor, captureViewBindings, captureViewPlacement, preactViewDefinition,
  type ContextToolDeclarations, type ContextToolMetadata, type ContextualViewType, type ToolSchemas,
  type ViewContextProps, type ViewNamingProps, type ViewRegionProps, type ViewType, type ViewTypeDeclaration,
} from '../tools/view-type-tool.js';

type MountProps<Definition extends ViewType> = ViewNamingProps<Definition> & ViewContextProps<NoInfer<Definition>> & {
  readonly name?: string;
  readonly onClose?: AppFrameView['onClose'];
  readonly children?: ComponentChildren;
};
export type ViewProps<Definition extends ViewType> = MountProps<Definition> & ViewRegionProps<Definition>;
type MountOptions = {
  readonly type: ViewType;
  readonly id?: string;
  readonly idPrefix?: string;
  readonly region?: ViewRegion;
  readonly name?: string;
  readonly onClose?: AppFrameView['onClose'];
  readonly context?: unknown;
  readonly children?: ComponentChildren;
};
type ViewComponent<Definition extends ViewType> = Definition & ((props: ViewProps<Definition>) => JSX.Element);

function mountedDefinition(definition: ViewType) {
  function Page(props: Omit<MountOptions, 'type'>) {
    return h(MountedView, { ...props, type: definition });
  }
  Object.defineProperties(Page, {
    [preactViewDefinition]: { value: definition },
    name: { value: definition.name },
    tools: { value: definition.tools },
    region: { value: definition.region },
    multiplicity: { value: definition.multiplicity },
  });
  return Object.freeze(Page);
}

export function defineViewType<Context extends object>(): <const M extends ViewMultiplicity,
  const Schemas extends ToolSchemas, const R extends ViewRegion | undefined = undefined>(
  declaration: ViewTypeDeclaration<M, R, Context> & { readonly tools?: ContextToolDeclarations<Context, Schemas> },
) => ViewComponent<ContextualViewType<ContextToolMetadata<Schemas>, Context, M, R>>;
export function defineViewType<const M extends ViewMultiplicity, const R extends ViewRegion | undefined = undefined>(
  declaration: ViewTypeDeclaration<M, R, undefined> & { readonly tools?: never },
): ViewComponent<ViewType<{}, M, R>>;
export function defineViewType(declaration?: unknown): unknown {
  if (arguments.length) {
    return mountedDefinition(defineDescriptor(declaration as ViewTypeDeclaration<ViewMultiplicity, ViewRegion | undefined, undefined>));
  }
  const define = defineDescriptor();
  return (source: Parameters<typeof define>[0]) => mountedDefinition(define(source));
}

export function StaticView<const Definition extends ViewType>(props: MountProps<Definition> & { readonly type: Definition }): JSX.Element {
  if (Object.hasOwn(props, 'region')) throw new TypeError('StaticView supplies its own region');
  return h(MountedView, { ...props, region: 'static' });
}

export function DynamicView<const Definition extends ViewType>(props: MountProps<Definition> & { readonly type: Definition }): JSX.Element {
  if (Object.hasOwn(props, 'region')) throw new TypeError('DynamicView supplies its own region');
  return h(MountedView, { ...props, region: 'dynamic' });
}

function MountedView(props: MountOptions): JSX.Element {
  const label = props.id ?? props.idPrefix ?? props.type.name;
  const parent = useContext(ViewRuntimeContext);
  if (parent) {
    throw Object.assign(new Error(
      `NESTED_VIEW_UNSUPPORTED: View "${label}" cannot be declared inside View "${parent.viewId}". Declare independent sibling Views.`,
    ), { code: 'NESTED_VIEW_UNSUPPORTED', parentViewId: parent.viewId, childViewId: label });
  }
  const app = useContext(AppRuntimeContext);
  if (!app) throw new Error('[AOTUI SDK] View requires a managed App');
  const type = app.resolveViewType(props.type);
  const placement = captureViewPlacement(type, props, props.context);
  const bindings = captureViewBindings(type, label, props.context);
  const slot = useMemo(() => {
    let attached: { node: HTMLDivElement; owner: object } | undefined;
    const { registry, readRefs, release } = app.createViewRefs(label);
    return {
      attach(node: HTMLDivElement | null) {
        if (!node && attached) {
          if (app.views.get(attached.node)?.owner === attached.owner) app.views.delete(attached.node);
          release();
          attached = undefined;
        } else if (node) attached = { node, owner: {} };
      },
      update(next: typeof placement, nextBindings: readonly AppFrameBinding[], viewType: string, onClose: AppFrameView['onClose']) {
        if (!attached) throw new Error('View commit requires a DOM attachment');
        app.views.set(attached.node, { ...next, type: viewType, owner: attached.owner, bindings: nextBindings, readRefs,
          ...(onClose === undefined ? {} : { onClose }) });
      },
      refs: {
        viewId: label,
        captureRef: registry.captureRef,
        registerRef: (...args: Parameters<typeof registry.registerRef>) => {
          if (!attached) throw new Error('Ref registration requires a DOM attachment');
          return registry.registerRef(...args);
        },
      },
    };
  }, [app]);
  useLayoutEffect(() => { slot.update(placement, bindings, type.name, props.onClose); });

  return h(ViewRuntimeContext.Provider, { value: slot.refs },
    h('div', { ref: slot.attach, 'data-aotui-view': type.name }, props.children));
}
