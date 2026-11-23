import type { AppSnapshot } from '../snapshot/types.js';
import type { RefArgumentSource } from '../tool/snapshot-value-arguments.js';
import type { AppInteraction, Issue, RequestSources } from './app-interaction-types.js';
import type { ObservedRef } from './observation-types.js';
import { readConsoleInputs } from './console-inputs.js';

export interface RefSourceHold {
    readonly source: RefArgumentSource;
    readonly snapshot: AppSnapshot;
    current(): AppSnapshot | undefined;
    isRefView(viewId: string, viewInstanceId: string): boolean;
    markDispatched(): void;
    release(): void;
}

export interface RequestSourceAuthority {
    readonly appId: string;
    selectedConsoleRefs(observationId: string): readonly ObservedRef[] | undefined;
    acquire(observationId: string): RefSourceHold | { issue: Issue };
}

export type IssuedAppClients = WeakMap<AppInteraction, () => boolean>;
interface BoundApp {
    readonly client: WeakRef<AppInteraction>;
    readonly authority: WeakRef<RequestSourceAuthority>;
    readonly observationId: string;
    readonly consoleRefs: readonly ObservedRef[];
}
export interface BoundRequestSources {
    readonly identity: symbol;
    readonly apps: ReadonlyMap<string, BoundApp>;
    readonly issued: IssuedAppClients;
}

const authorities = new WeakMap<AppInteraction, RequestSourceAuthority>();
const bindings = new WeakMap<RequestSources, BoundRequestSources>();

export function registerRequestSource(client: AppInteraction, authority: RequestSourceAuthority): void {
    authorities.set(client, authority);
}

export function forwardRequestSource(client: AppInteraction, original: AppInteraction): void {
    const authority = authorities.get(original);
    if (authority) registerRequestSource(client, authority);
}

function invalid(message: string): never {
    throw Object.assign(new TypeError(message), { code: 'REQUEST_SOURCES_INVALID' });
}

function dataField(object: unknown, name: string): unknown {
    if (object === null || typeof object !== 'object') return undefined;
    const field = Object.getOwnPropertyDescriptor(object, name);
    return field?.enumerable && 'value' in field ? field.value : undefined;
}

export function bindRequestSources(input: unknown, issued: IssuedAppClients): RequestSources {
    const supplied = dataField(input, 'apps');
    if (!Array.isArray(supplied)) invalid('Provide a list of adopted App observations.');
    const apps = new Map<string, BoundApp>();
    for (let i = 0; i < supplied.length; i++) {
        const entry = dataField(supplied, String(i));
        const client = dataField(entry, 'client') as AppInteraction;
        const observationId = dataField(entry, 'observationId');
        const authority = authorities.get(client);
        if (!authority || !issued.get(client)?.() || typeof observationId !== 'string')
            invalid('Every source must be an adopted observation of a current App client issued by this Desktop.');
        const consoleRefs = authority.selectedConsoleRefs(observationId);
        if (!consoleRefs)
            invalid('Every source must be an adopted observation of a current App client issued by this Desktop.');
        if (apps.has(authority.appId)) invalid('Use one observation per running App.');
        apps.set(authority.appId, { client: new WeakRef(client), authority: new WeakRef(authority), observationId, consoleRefs });
    }
    const binding = { identity: Symbol(), apps, issued };
    const token = Object.freeze({ readConsoleInputs: (imports?: readonly string[]) =>
        readConsoleInputs(apps, appId => acquireRequestSource(binding, appId), imports) }) as RequestSources;
    bindings.set(token, binding);
    return token;
}

export function requestSourcesFor(token: RequestSources, target: RequestSourceAuthority, observationId: string): BoundRequestSources | undefined {
    const binding = bindings.get(token);
    const app = binding?.apps.get(target.appId);
    return app?.authority.deref() === target && app.observationId === observationId ? binding : undefined;
}

export function requestAppIsAvailable(binding: BoundRequestSources, appId: string): boolean {
    const client = binding.apps.get(appId)?.client.deref();
    return !!client && binding.issued.get(client)?.() === true;
}

export function acquireRequestSource(binding: BoundRequestSources, appId: string): RefSourceHold | { issue: Issue } | undefined {
    const entry = binding.apps.get(appId);
    const client = entry?.client.deref();
    const authority = entry?.authority.deref();
    if (!entry || !client || !authority || !binding.issued.get(client)?.()) return;
    const hold = authority.acquire(entry.observationId);
    if ('issue' in hold) return hold;
    return { ...hold, current: () => binding.issued.get(client)?.() ? hold.current() : undefined };
}
