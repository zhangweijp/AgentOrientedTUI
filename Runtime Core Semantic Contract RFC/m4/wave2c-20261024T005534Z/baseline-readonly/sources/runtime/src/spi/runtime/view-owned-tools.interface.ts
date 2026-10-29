import type { TypeToolDefinition } from '../app/public-types.js';

/** M4 Stage 1 opt-in View-local Tool registration; not an execution authority. */
export interface IViewOwnedToolPort {
    mount(viewId: string, viewType: string): string;
    unmount(viewInstanceId: string): void;
    registerTool(viewInstanceId: string, toolName: string, definition: TypeToolDefinition): () => void;
    /** Read-only canonical contract key; does not register or evaluate getters. */
    fingerprintParams(params: unknown): string;
}
