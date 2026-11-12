import { h, type ComponentChildren } from 'preact';
import { useContext, useErrorBoundary, useLayoutEffect, useRef } from 'preact/hooks';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import {
    createToolBindings, defineToolSet, getToolCatalog,
    type ExactBindings, type ToolBindings, type ToolSet, type ToolSetMap, type ToolMap,
} from '../tools/view-type-tool.js';

type AnyToolSet = ReturnType<typeof defineToolSet>;
export type AppToolsProps<
    Definition extends AnyToolSet,
    Bindings extends ToolBindings<ToolSetMap<Definition>> = ToolBindings<ToolSetMap<Definition>>,
> = Readonly<{
    definition: Definition;
    bindings: Bindings & ExactBindings<Bindings, ToolSetMap<Definition>>;
    children?: ComponentChildren;
}>;

function authorError(code: string, message: string): Error & { readonly code: string } {
    return Object.assign(new Error(code + ': ' + message), { code });
}

export function AppTools<const Map extends ToolMap, const Bindings extends ToolBindings<Map>>(
    { definition, bindings, children }: Readonly<{
        definition: ToolSet<Map>;
        bindings: Bindings & ExactBindings<Bindings, Map>;
        children?: ComponentChildren;
    }>,
) {
    const context = useContext(AppRuntimeContext);
    if (!context) throw authorError('APP_TOOLS_APP_REQUIRED', 'Place AppTools inside a managed App.');
    const port = context.appTypeTools;
    const fixed = useRef<ReturnType<typeof bind>>();
    function bind() {
        const controller = createToolBindings(definition, port);
        const dispose = () => {
            try {
                if (!controller.disposed) controller.dispose();
            }
            finally {
                if (controller.disposed) {
                    context!.toolCleanup?.delete(dispose);
                    context!.toolOwners?.active.delete(dispose);
                } else context!.toolCleanup?.add(dispose);
            }
        };
        return { definition, port, controller, dispose };
    }

    fixed.current ??= bind();
    const owner = fixed.current;
    if (owner.definition !== definition || owner.port !== port) {
        throw authorError('APP_TOOLS_IDENTITY_CHANGED', 'ToolSet and App port are fixed. Unmount AppTools and remount with a new key before replacing them.');
    }
    const commit = owner.controller.prepare(bindings);
    // Preact can run parent layout effects before an outer boundary renders its
    // fallback. A descendant error escaping this frame invalidates its bindings.
    let failed = false;
    useErrorBoundary(error => {
        failed = true;
        throw error;
    });
    useLayoutEffect(() => owner.dispose, []);
    useLayoutEffect(() => {
        if (failed) return;
        let failure: { error: unknown } | undefined;
        for (const cleanup of [...(context.toolCleanup ?? [])]) {
            try { cleanup(); } catch (error) { failure ??= { error }; }
        }
        if (failure) throw failure.error;
        if (context.toolOwners?.closed) return;
        // Enroll before registerTypeTool, which can synchronously re-enter cleanup.
        context.toolOwners?.active.add(owner.dispose);
        try { commit(); }
        catch (error) { context.toolCleanup?.add(owner.dispose); throw error; }
        finally {
            if (owner.controller.disposed) {
                context.toolCleanup?.delete(owner.dispose);
                context.toolOwners?.active.delete(owner.dispose);
            }
        }
    });
    return children ?? null;
}

// Keep the existing descriptor-list type available alongside the component value.
export type ToolCatalog = import('../tools/view-type-tool.js').ToolCatalog;
export interface ToolCatalogProps { readonly definition: AnyToolSet }
export function ToolCatalog({ definition }: ToolCatalogProps) {
    const groups = new Map<string, string[]>();
    for (const { viewType, name } of getToolCatalog(definition)) {
        const names = groups.get(viewType) ?? [];
        names.push(name);
        groups.set(viewType, names);
    }
    return h('section', { 'data-role': 'tool-catalog' }, [
        h('h2', {}, 'Tools by ViewType'),
        ...[...groups].map(([viewType, names]) => h('section', { key: viewType }, [
            h('h3', {}, viewType),
            h('ul', {}, names.map(name => h('li', { key: name }, name))),
        ])),
    ]);
}
