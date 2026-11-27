import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import Type from 'typebox';
import { createApp, createView, defineViewType, formatRef, ref, type ToolResult } from '@aotui/sdk';

type Actions = {
    finish(): Promise<ToolResult>;
    check(): ToolResult;
    export(): ToolResult;
    setPriority(priority: number): Promise<ToolResult>;
    inspectPriority(observed: number): ToolResult;
    priority: number;
};
const empty = Type.Object({}, { additionalProperties: false });
const number = Type.Object({ value: Type.Number() }, { additionalProperties: false });
const Todo = defineViewType<Actions>()({
    name: 'todo', region: 'dynamic', multiplicity: 'single', tools: {
        mark_done: { description: 'Mark the task as done', inputSchema: empty, execute: ({ context }) => context.finish() },
        check: { description: 'Read task completion and the handling count', inputSchema: empty, execute: ({ context }) => context.check() },
        export_todos: { description: 'Export the task to CSV', inputSchema: empty, execute: ({ context }) => context.export() },
        set_priority: { description: 'Set the task priority', inputSchema: number, execute: ({ input, context }) => context.setPriority(input.value) },
        inspect_priority: { description: 'Compare the observed and live priority', inputSchema: number,
            enabled: context => context.priority > 0, execute: ({ input, context }) => context.inspectPriority(input.value) },
    },
});

export default createApp({
    app_name: 'tasks', viewTypes: [Todo],
    initialize({ launchConfig, publish: commit }) {
        let done = false, priority = 1, attempts = 0, commits = 0;
        const view = (() => { const handle = createView(Todo); return { handle, frame: () => {
            const value = ref('priority', priority, { schema: Type.Number(), scope: 'protected' });
            const actions: Actions = {
                async finish() {
                    const attempt = ++attempts;
                    const changed = !done;
                    done = true;
                    return { success: true, data: { attempt, prepared: publish(changed) } };
                },
                check: () => ({ success: true, data: { done, attempts, commits } }),
                export() {
                    const folder = launchConfig?.folder;
                    if (typeof folder !== 'string') throw new Error('The export folder is required');
                    appendFileSync(join(folder, 'todos.csv'), `task,${done ? 'done' : 'pending'}\n`);
                    return { success: true, data: { path: 'todos.csv', count: 1 } };
                },
                async setPriority(value) {
                    const changed = priority !== value;
                    priority = value;
                    return { success: true, data: { prepared: publish(changed) } };
                },
                inspectPriority: observed => ({ success: true, data: { observed, current: priority } }),
                priority,
            };
            return handle.frame({ body: (done ? 'Done' : 'Pending') + '\n\n' + formatRef('Task priority', value), refs: [value], context: actions });
        } }; })();
        let prepared = commit(() => ([view]).map(page => page.frame()));
        commits++;
        function publish(changed: boolean) {
            if (changed) {
                prepared = commit(() => ([view]).map(page => page.frame()));
                commits++;
            }
            return prepared;
        }
    },
});
