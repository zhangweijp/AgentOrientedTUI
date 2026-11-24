import { createHash } from 'node:crypto';
import { jsonSchema, type Tool, type ToolResult } from '@aotui/agent-driver-v2';
import type { ActiveTurn, InvocationReceipt } from '@aotui/runtime';
import type { PresentedRef } from '@aotui/runtime/adapters';
import type { PendingAppReceipt } from '../semantic-aotui-driven-source.js';
import { consoleDeclarations, RUN_CODE, type ConsoleToolDeclaration } from './declarations.js';
import type { ConsoleExecutor } from './node-process.js';
import { record } from './program-wire.js';

export { RUN_CODE };
export interface ConsoleRoutedCall { result: ToolResult; receipt?: InvocationReceipt; pending?: PendingAppReceipt }
type Dispatch = (name: string, args: Record<string, unknown>, id: string, signal: AbortSignal) => Promise<ConsoleRoutedCall>;

const reject = (id: string, code: string, message: string): ToolResult =>
    ({ toolName: RUN_CODE, toolCallId: id, outcomeStatus: 'rejected', error: { code, message } });
const maxImports = 256;
function argsSchema(scoped: boolean, strict: boolean) {
    const imports = { type: 'array' as const, maxItems: maxImports, items: { type: 'string' as const } };
    return {
        type: 'object' as const, additionalProperties: false,
        required: strict ? ['code', 'imports', ...(scoped ? ['reset'] : [])] : ['code'],
        properties: {
            code: { type: 'string' as const, ...(strict ? { pattern: '[\\s\\S]' } : { minLength: 1 }),
                description: scoped ? 'JavaScript for the current scoped session. Top-level await is available.' : 'The body of an async TypeScript function.' },
            imports: strict ? { anyOf: [imports, { type: 'null' as const }],
                description: 'Use null for the original observation’s default inputs, [] for no Refs, or a list of public Ref addresses.' }
                : { ...imports, description: 'Optional public Ref addresses for this run. An empty array uses no Refs.' },
            ...(scoped ? { reset: { type: 'boolean' as const, description: 'Use false to keep the current scope or true to start an empty scope.' } } : {}),
        },
    };
}

export function createConsoleTool(tools: readonly ConsoleToolDeclaration[], refs: readonly PresentedRef[], executor: ConsoleExecutor,
    strict = false): {
    schema: ReturnType<typeof argsSchema>;
    tool: Tool;
    execute(args: unknown, id: string, turn: Pick<ActiveTurn, 'readConsoleInputs'>, signal: AbortSignal, dispatch: Dispatch,
        remember: (locator: PendingAppReceipt, result: ToolResult) => void): Promise<ToolResult>;
} {
    const sdk = consoleDeclarations(tools, refs);
    const bindings = new Set(sdk.names);
    const scoped = executor.mode === 'scoped';
    const status = [
        scoped ? 'Run JavaScript in this live Agent’s isolated scoped Console. Top-level await, variables and functions are supported. Each call runs only its new code. A declaration shadows an old name while existing closures retain their bindings.'
            : 'Run a fresh isolated TypeScript async function body. await and return are supported; variables end with this call.',
        ...(scoped ? ['The declaration below describes this request’s refs and tools. Use JavaScript for code. Get tools again each run; saved tool handles expire. Set reset: true to start empty. A lost scope requires recreating local values.'] : []),
        'Use inspect(value) or console.log(value) for bounded output. Use only the declared App tools through tools[name](args).',
        'refs contains public values from this request. Use imports to select a subset. Pass compatible $ref. addresses to ordinary or published-Ref parameters, and use $$ref. for literal text starting with $ref.',
        'Only the tools already published in this request are callable. Check child receipts before retrying.',
        'A tool failure rejects with ToolCallError. Catch it to read toolName, code and message and continue.',
        ...sdk.issues.map(issue => 'Program binding omitted for ' + JSON.stringify(issue.tool) + ' at ' + issue.path + '. The native Tool remains available.'),
        '\n' + sdk.declaration,
    ].join('\n');
    const calls = new Map<string, { readonly fingerprint: string; readonly result: Promise<ToolResult> }>();

    async function run(code: string, imports: readonly string[] | undefined, reset: boolean, callId: string, turn: Pick<ActiveTurn, 'readConsoleInputs'>,
        signal: AbortSignal, dispatch: Dispatch, remember: (locator: PendingAppReceipt, result: ToolResult) => void): Promise<ToolResult> {
        const inputs = await turn.readConsoleInputs(imports);
        if (inputs.status === 'rejected') return reject(callId, inputs.issue.code, inputs.issue.message);
        const receipts: Array<{ invocationId: string; toolName: string; status: string; phase: string; code?: string }> = [];
        const pending: PendingAppReceipt[] = [];
        const result = await executor({
            code, ...(reset ? { reset: true } : {}), names: sdk.names, inputs, signal,
            async recheck() {
                const current = await turn.readConsoleInputs(imports);
                if (current.status === 'rejected') return current.issue;
            },
            async invoke(name, args, slot, cancellation) {
                const id = 'console:' + createHash('sha256').update(callId).digest('hex') + ':' + slot;
                if (!bindings.has(name)) return reject(id, 'TOOL_NOT_AVAILABLE', 'Choose a Tool declared for this program.');
                const called = await dispatch(name, args, id, cancellation);
                const { result, receipt } = called;
                if (called.pending) pending.push(called.pending);
                receipts.push({ invocationId: id, toolName: name, status: result.outcomeStatus ?? 'unknown',
                    phase: receipt?.executionPhase ?? (result.outcomeStatus === 'unknown' || result.outcomeStatus === 'accepted' ? 'unknown' : 'not-dispatched'),
                    ...(result.error ? { code: result.error.code } : {}) });
                return result;
            },
        });
        const recovery = result.scope === 'lost'
            ? ' All Console local variables and closures were lost. Recreate them in a fresh run and check original child receipts before repeating writes.' : '';
        const output: ToolResult = { toolName: RUN_CODE, toolCallId: callId, outcomeStatus: result.error ? 'failed' : 'succeeded',
            result: { output: result.output, ...(result.truncated ? { truncated: true } : {}),
                ...(result.scope ? { scope: result.scope } : {}), subcalls: receipts },
            ...(result.error ? { error: { code: result.error.code, message: result.error.message + recovery } } : {}) };
        for (const locator of pending) remember(locator, output);
        return output;
    }

    const schema = argsSchema(scoped, strict);
    return {
        schema, tool: { description: status, inputSchema: jsonSchema(schema) },
        execute(args: unknown, id: string, turn: Pick<ActiveTurn, 'readConsoleInputs'>, signal: AbortSignal, dispatch: Dispatch,
            remember: (locator: PendingAppReceipt, result: ToolResult) => void): Promise<ToolResult> {
            const input = record(args) ? args : {};
            const { code, imports: suppliedImports, reset } = input;
            const imports = strict && suppliedImports === null ? undefined : suppliedImports;
            if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 24 * 1024 ||
                Object.keys(input).some(key => key !== 'code' && key !== 'imports' && !(scoped && key === 'reset')) ||
                (strict && (suppliedImports === undefined || scoped && reset === undefined)) ||
                (reset !== undefined && typeof reset !== 'boolean') ||
                (imports !== undefined && (!Array.isArray(imports) || imports.length > maxImports ||
                    imports.some(path => typeof path !== 'string' || Buffer.byteLength(path) > 4096)))) {
                return Promise.resolve(reject(id, 'CONSOLE_INVALID_INPUT', strict
                    ? 'Supply nonblank code up to 24 KiB and imports as null or a bounded array.' + (scoped ? ' Set reset to false or true.' : '')
                    : scoped
                    ? 'Supply JavaScript up to 24 KiB, an optional bounded imports list, and an optional boolean reset.'
                    : 'Supply a TypeScript function body up to 24 KiB and optionally a bounded list of Ref addresses.'));
            }
            const fingerprint = JSON.stringify([code, imports, reset === true]);
            const prior = calls.get(id);
            if (prior) return prior.fingerprint === fingerprint ? prior.result :
                Promise.resolve(reject(id, 'INVOCATION_ID_CONFLICT', 'This call ID already ran a different Console program.'));
            if (calls.size >= 16) return Promise.resolve(reject(id, 'CONSOLE_CALL_CAPACITY', 'Prepare a new observation before running more programs.'));
            const selected = imports === undefined ? undefined : [...imports as string[]];
            const result = run(code, selected, reset === true, id, turn, signal, dispatch, remember)
                .catch(() => reject(id, 'CONSOLE_UNAVAILABLE', 'The program environment could not be prepared.'));
            calls.set(id, { fingerprint, result });
            return result;
        },
    };
}
