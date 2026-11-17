import { canonicalJson } from '../snapshot/json.js';
import type { ToolInvocationDescriptor, ViewSnapshot, ViewToolReceiver } from '../snapshot/types.js';

export function sameToolDefinition(a: ToolInvocationDescriptor, b: ToolInvocationDescriptor): boolean {
    return a === b || a.id === b.id && a.name === b.name && a.viewType === b.viewType &&
        a.description === b.description && canonicalJson(a.inputSchema) === canonicalJson(b.inputSchema);
}

export function viewToolReceiver(view: ViewSnapshot, toolId: string): ViewToolReceiver | undefined {
    const binding = view.toolBindings.find(candidate => candidate.toolId === toolId);
    return binding && Object.freeze({ viewId: view.id, viewInstanceId: view.viewInstanceId, activationId: binding.activationId });
}
