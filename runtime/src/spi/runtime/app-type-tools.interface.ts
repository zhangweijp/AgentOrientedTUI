import { ORDINARY_INVOCATION_MODE } from '../../core/tool/invocation-terminal.js';
export const VIEW_TYPE_TOOL_PROTOCOL = 'view-type-tools-v4' as const;
import type { OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
export type { SafeOrdinaryInvoker } from '../../core/tool/invocation-terminal.js';

/** Public JSON contract for one App-owned ViewType Tool. */
export interface AppTypeToolDefinition {
    readonly viewType: string;
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** Trusted factory. The Runtime compiles and owns the actual parameter contract. */
export interface AppTypeToolRegistrationOptions {
    readonly safeOrdinaryParametersInvocationMode: typeof ORDINARY_INVOCATION_MODE;
    readonly createSafeOrdinaryParametersInvoker: (contract: OrdinaryParameterContract) => import('../../core/tool/invocation-terminal.js').SafeOrdinaryInvoker;
}

/** One stable SDK registration in a complete frame. */
export interface AppFrameTool {
    readonly definition: AppTypeToolDefinition;
    readonly options: AppTypeToolRegistrationOptions;
}

/** App-level registration for the ordinary, type-scoped Tool execution path. */
export interface IAppTypeToolPort {
    readonly protocol: typeof VIEW_TYPE_TOOL_PROTOCOL;
    registerTypeTool(definition: AppTypeToolDefinition, options: AppTypeToolRegistrationOptions): () => void;
}
