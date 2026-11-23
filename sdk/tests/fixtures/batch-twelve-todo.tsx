import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { useLayoutEffect, useRef } from 'preact/hooks';
import Type from 'typebox';
import { createTUIApp, defineViewType, type ToolResult, useAppRuntimeContext, useDataRef, useState } from '@aotui/sdk';

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

function Priority({ value }: { value: number }) {
    const ref = useDataRef('priority', value, { scope: 'protected' });
    return <p>{ref('Task priority')}</p>;
}

function Tasks() {
    const [done, setDone] = useState(false);
    const [priority, setPriority] = useState(1);
    const attempts = useRef(0), commits = useRef(0);
    const { launchConfig, prepareProjection } = useAppRuntimeContext();
    useLayoutEffect(() => { commits.current++; });
    const actions: Actions = {
        async finish() {
            const attempt = ++attempts.current;
            const prepared = await prepareProjection(() => setDone(true));
            return { success: true, data: { attempt, prepared } };
        },
        check: () => ({ success: true, data: { done, attempts: attempts.current, commits: commits.current } }),
        export() {
            const folder = launchConfig?.folder;
            if (typeof folder !== 'string') throw new Error('The export folder is required');
            appendFileSync(join(folder, 'todos.csv'), `task,${done ? 'done' : 'pending'}\n`);
            return { success: true, data: { path: 'todos.csv', count: 1 } };
        },
        async setPriority(value) {
            const prepared = await prepareProjection(() => setPriority(value));
            return { success: true, data: { prepared } };
        },
        inspectPriority: observed => ({ success: true, data: { observed, current: priority } }),
        priority,
    };
    return <Todo context={actions}><p>{done ? 'Done' : 'Pending'}</p><Priority value={priority} /></Todo>;
}

const app: ReturnType<typeof createTUIApp> = createTUIApp({ app_name: 'tasks', viewTypes: [Todo], component: Tasks });
export default app;
