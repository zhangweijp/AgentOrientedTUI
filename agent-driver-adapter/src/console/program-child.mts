/* Async function-body evaluation adapted from DeepSeek Harness async-function.ts.
 * Copyright (c) 2026 DeepSeek. See LICENSE.deepseek-harness. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream, createWriteStream } from 'node:fs';
import { inspect as print } from 'node:util';
import { createContext, runInContext } from 'node:vm';
import * as nodeModule from 'node:module';
import { ScopedReplScopes } from './scoped-repl.js';
import { clipText, frame, MAX_CALLS, MAX_LOGS, OUTPUT_BYTES, readFrames, record, VERSION, writeFrame } from './program-wire.js';

const input = createReadStream('', { fd: 3 });
const output = createWriteStream('', { fd: 4 });
const usable = (nodeModule as unknown as { stripTypeScriptTypes?: (source: string) => string }).stripTypeScriptTypes;
const mode = process.argv[2] === 'scoped' ? 'scoped' : 'once';
const scopes = new ScopedReplScopes();
const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const ProgramError = runInContext('Error', context) as ErrorConstructor;
class ToolCallError extends ProgramError {
    override readonly name = 'ToolCallError';
    constructor(readonly toolName: string, readonly code: string, message: string) { super(message); }
}
const empty = Object.freeze(Object.create(null) as Record<string, unknown>);
const noTools = Object.freeze(Object.create(null) as Run['tools']);
const partial = new WeakSet<object>();
const prototypes = new Set<object | null>([null, Object.prototype, Array.prototype,
    runInContext('Object.prototype', context), runInContext('Array.prototype', context)]);
type Pending = { resolve(value: unknown): void; reject(code: string, message: string): void };
type Run = {
    id: number; refs: Record<string, unknown>; tools: Record<string, (args: unknown) => Promise<unknown>>;
    calls: Map<number, Pending>; sent: number; bytes: number; logs: number; truncated: boolean;
};
const executing = new AsyncLocalStorage<Run>();
let prepared: { id: number; message: Record<string, unknown> } | undefined;
let active: Run | undefined;
let lastRun = 0;
const stale = 'This Tool binding belongs to an ended Console run. Look up tools again in the current run.';

function finish(run: Run, error?: { code: string; message: string }): void {
    if (active !== run) return;
    active = undefined;
    run.refs = empty;
    run.tools = noTools;
    for (const pending of run.calls.values()) pending.reject('CONSOLE_TOOL_SCOPE_ENDED', stale);
    run.calls.clear();
    const result = { type: 'done', run: run.id, ...(error ? { error } : {}), ...(run.truncated ? { truncated: true } : {}) };
    if (mode === 'once') {
        input.destroy();
        output.end(frame(result), () => process.exit(0));
    } else writeFrame(output, result);
}

function log(...values: unknown[]): void {
    const run = executing.getStore();
    if (!run || run !== active || run.truncated) return;
    if (++run.logs > MAX_LOGS) { run.truncated = true;return; }
    const options = { customInspect: false, getters: false, depth: 5, maxArrayLength: 100, maxStringLength: OUTPUT_BYTES };
    const text = values.map(value => typeof value === 'string' ? value : print(value, options)).join(' ');
    const formatted = clipText(text, OUTPUT_BYTES - run.bytes);
    if (formatted.length < text.length) run.truncated = true;
    if (formatted || !run.truncated) {
        run.bytes += Buffer.byteLength(formatted);
        writeFrame(output, { type: 'log', run: run.id, text: formatted });
    }
}
const console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
Object.defineProperties(context, {
    ToolCallError: { value: ToolCallError },
    inspect: { value: log },
    console: { value: console },
    refs: { get: () => executing.getStore() === active ? active?.refs ?? empty : empty },
    tools: { get: () => executing.getStore() === active ? active?.tools ?? noTools : noTools },
});

function freezeRefs(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) freezeRefs(child);
    if (!Array.isArray(value)) Object.setPrototypeOf(value, null);
    Object.freeze(value);
}

/** Validate actual JSON and forbid passing a synthetic Ref branch as a business object. */
function copyArguments(value: unknown, partial: WeakSet<object>, prototypes: ReadonlySet<object | null>): unknown {
    let nodes = 0, bytes = 0;
    const seen = new WeakSet<object>();
    const bounded = (size: number) => {
        bytes += size;
        if (bytes > 128 * 1024) throw new TypeError('Tool arguments exceed the Console limit.');
    };
    const walk = (item: unknown, depth: number): unknown => {
        if (++nodes > 5_000 || depth > 32) throw new TypeError('Tool arguments exceed the Console limit.');
        if (typeof item === 'string') { bounded(Buffer.byteLength(item));return item; }
        if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
        if (!item || typeof item !== 'object' || seen.has(item)) throw new TypeError('Tool arguments must be JSON values.');
        if (partial.has(item)) throw new TypeError('Select leaves from a partial Ref, then build a business value explicitly.');
        if (!prototypes.has(Object.getPrototypeOf(item))) throw new TypeError('Tool arguments must be plain JSON objects or arrays.');
        seen.add(item);
        const fields = Object.getOwnPropertyDescriptors(item);
        const keys = Reflect.ownKeys(fields);
        const result: Record<string, unknown> = Object.create(null);
        const array = Array.isArray(item);
        if (array && keys.length !== item.length + 1) throw new TypeError('Tool arrays must be dense JSON arrays.');
        for (const key of keys) {
            if (array && key === 'length') continue;
            if (typeof key !== 'string' || !fields[key]?.enumerable || !('value' in fields[key]!) ||
                (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)))
                throw new TypeError('Tool arguments must have only JSON data properties.');
            bounded(Buffer.byteLength(key));
            result[key] = walk(fields[key]!.value, depth + 1);
        }
        seen.delete(item);
        return array ? Object.values(result) : result;
    };
    if (!record(value)) throw new TypeError('Supply a JSON object as Tool arguments.');
    return walk(value, 0);
}

function programFailure(error: unknown) {
    let message: string;
    try { message = record(error) && typeof error.message === 'string' ? error.message : String(error); }
    catch { message = 'Program threw a value that could not be rendered.'; }
    return { code: 'CONSOLE_PROGRAM_FAILED', message: clipText(message, 512) };
}

function begin(id: number, program: Record<string, unknown>): void {
    if (typeof program.code !== 'string' || !Array.isArray(program.names) || !record(program.refs) || !Array.isArray(program.paths))
        throw new Error('Invalid Console initialization.');
    const refs = program.refs;
    partial.add(refs);
    for (const path of program.paths) {
        if (!Array.isArray(path)) throw new Error('Invalid Console Ref path.');
        let branch = refs;
        for (const segment of path.slice(0, -1)) {
            if (typeof segment !== 'string' || !record(branch[segment])) throw new Error('Invalid Console Ref branch.');
            branch = branch[segment] as Record<string, unknown>;
            partial.add(branch);
        }
    }
    freezeRefs(refs);
    const tools = Object.create(null) as Run['tools'];
    const run: Run = { id, refs, tools, calls: new Map(), sent: 0, bytes: 0, logs: 0, truncated: false };
    for (const name of program.names) {
        if (typeof name !== 'string') throw new Error('Invalid Console Tool name.');
        tools[name] = async args => {
            if (run !== active || executing.getStore() !== run) throw new ToolCallError(name, 'CONSOLE_TOOL_SCOPE_ENDED', stale);
            if (run.sent >= MAX_CALLS) throw new Error('Console Tool call limit reached.');
            const detached = copyArguments(args, partial, prototypes);
            const id = run.sent + 1;
            const message = frame({ type: 'invoke', run: run.id, id, name, input: detached });
            run.sent = id;
            return new Promise((resolve, reject) => {
                run.calls.set(id, { resolve, reject: (code, message) => reject(new ToolCallError(name, code, message)) });
                output.write(message);
            });
        };
    }
    Object.freeze(tools);
    active = run;
    const code = program.code;
    void executing.run(run, async () => {
        try {
            if (mode === 'scoped') await scopes.compile(code, context)();
            else {
                const source = usable!('(async function(refs, tools, inspect, console) {\n"use strict";\n' + code + '\n})');
                await runInContext(source, context, { filename: 'console-program.ts' })(refs, tools, log, console);
            }
            finish(run);
        } catch (error) { finish(run, programFailure(error)); }
    });
}

process.on('unhandledRejection', error => {
    const run = executing.getStore();
    if (run) finish(run, programFailure(error));
});
output.on('error', () => process.exit(1));
input.on('end', () => process.exit(0));
readFrames(input, message => {
    if (message.type === 'run' && !prepared && !active && message.run === lastRun + 1 && message.version === VERSION) {
        prepared = { id: ++lastRun, message };
        writeFrame(output, { type: 'initialized', run: lastRun });
        return;
    }
    if (message.type === 'begin' && prepared && message.run === prepared.id) {
        const next = prepared;
        prepared = undefined;
        begin(next.id, next.message);
        return;
    }
    if (message.type === 'skip' && prepared && message.run === prepared.id) {
        prepared = undefined;
        return;
    }
    if (message.type === 'result' && typeof message.run === 'number' && typeof message.id === 'number') {
        if (message.run !== active?.id) return;
        const handler = active.calls.get(message.id);
        if (!handler) return;
        active.calls.delete(message.id);
        if (message.error === undefined) handler.resolve(message.value);
        else if (record(message.error) && typeof message.error.code === 'string' && typeof message.error.message === 'string') {
            handler.reject(message.error.code, message.error.message);
        } else throw new Error('Invalid Console Tool error.');
        return;
    }
    throw new Error('Unexpected Console handoff.');
}, () => process.exit(1));
if (mode === 'once' && !usable) process.exit(1);
writeFrame(output, { type: 'ready', version: VERSION, mode });
