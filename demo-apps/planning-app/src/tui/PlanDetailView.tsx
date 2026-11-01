import { defineParams, useArrayRef, useDataRef, useViewTypeTool } from '@aotui/sdk';
import type { Phase, Plan, TaskInput, TaskItem } from '../types.js';

type PlanDetailViewProps = {
    plan: Plan;
    addPhase: (title: string, description?: string, tasks?: TaskInput[]) => Promise<string | null>;
    deletePhase: (phaseId: string) => Promise<boolean>;
    completePhase: (phaseId: string) => Promise<boolean>;
    addTask: (phaseId: string, title: string, description?: string) => Promise<string | null>;
    updateTask: (taskId: string, updates: { title?: string; description?: string }) => Promise<boolean>;
    deleteTask: (taskId: string) => Promise<boolean>;
    completeTask: (taskId: string) => Promise<boolean>;
};

const splitPhases = (phases: Phase[]) => {
    const completed: Phase[] = [];
    const pending: Phase[] = [];
    phases.forEach(phase => phase.status === 'completed' ? completed.push(phase) : pending.push(phase));
    return { completed, current: pending[0] || null, upcoming: pending.slice(1) };
};
const addRefAliases = <T,>(map: Map<string, T>, base: string, type: string, index: number, value: T) => {
    map.set(`${base}[${index}]`, value);
    map.set(`${type}:${base}[${index}]`, value);
};

export function PlanDetailView({ plan, addPhase, deletePhase, completePhase, addTask, updateTask, deleteTask, completeTask }: PlanDetailViewProps) {
    const { completed, current, upcoming } = splitPhases(plan.phases);
    const completedTasks = current ? current.tasks.filter(task => task.status === 'completed') : [];
    const pendingTasks = current ? current.tasks.filter(task => task.status === 'pending') : [];

    // These maps deliberately contain only references rendered by this View.
    // Business callbacks receive ids only after the current View resolves them.
    const phasesByRef = new Map<string, Phase>();
    if (current) phasesByRef.set('current_phase', current);
    completed.forEach((phase, index) => addRefAliases(phasesByRef, 'completed_phases', 'Phase', index, phase));
    upcoming.forEach((phase, index) => addRefAliases(phasesByRef, 'upcoming_phases', 'Phase', index, phase));

    const tasksByRef = new Map<string, { task: TaskItem; phaseId: string }>();
    const addTaskRefs = (base: string, tasks: TaskItem[], phaseId: string) => {
        tasks.forEach((task, index) => {
            const binding = { task, phaseId };
            addRefAliases(tasksByRef, base, 'Task', index, binding);
        });
    };
    if (current) {
        addTaskRefs('pending_tasks', pendingTasks, current.id);
        addTaskRefs('completed_tasks', completedTasks, current.id);
    }
    upcoming.forEach((phase, phaseIndex) => {
        addTaskRefs(`upcoming_phase_${phaseIndex}_tasks`, phase.tasks, phase.id);
    });
    const resolvePhase = (refId: string) => phasesByRef.get(refId) ?? null;
    const resolveTask = (refId: string) => tasksByRef.get(refId) ?? null;

    const planRef = useDataRef('plan_detail_current', plan);
    const currentPhaseRef = useDataRef('current_phase', current ?? { title: 'No current phase' });
    const [, completedPhaseRef] = useArrayRef('completed_phases', completed, { itemType: 'Phase' });
    const [, pendingTaskRef] = useArrayRef('pending_tasks', pendingTasks, { itemType: 'Task' });
    const [, completedTaskRef] = useArrayRef('completed_tasks', completedTasks, { itemType: 'Task' });
    const [, upcomingPhaseRef] = useArrayRef('upcoming_phases', upcoming, { itemType: 'Phase' });

    const [AddPhaseTool] = useViewTypeTool('add_phase', {
        description: 'Add a phase to the current plan, optionally with initial tasks.',
        params: defineParams({
            title: { type: 'string', required: true, desc: 'Phase title' },
            description: { type: 'string', required: false, desc: 'Optional phase description' },
            tasks: { type: 'array', required: false, itemType: 'object', desc: 'Initial tasks: [{ title, description? }]' },
        }),
    }, async args => {
        const tasks = (args.tasks ?? []) as unknown as TaskInput[];
        if (!await addPhase(args.title, args.description, tasks)) return { success: false, error: { code: 'PHASE_ADD_FAILED', message: 'Add phase failed' } };
        return { success: true, data: { message: `Phase added with ${tasks.length} tasks.` } };
    });

    const [DeletePhaseTool] = useViewTypeTool('delete_phase', {
        description: 'Delete a Phase reference currently shown in this PlanDetail View.',
        params: defineParams({ phase: { type: 'string', required: true, desc: 'Phase reference id currently shown in this PlanDetail View.' } }),
    }, async args => {
        const phase = resolvePhase(args.phase);
        if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Pass a currently shown Phase reference.' } };
        if (!await deletePhase(phase.id)) return { success: false, error: { code: 'PHASE_DELETE_FAILED', message: 'Phase delete failed' } };
        return { success: true, data: { message: 'Phase deleted.' } };
    });

    const [CompletePhaseTool] = useViewTypeTool('complete_phase', {
        description: 'Complete a Phase reference currently shown in this PlanDetail View.',
        params: defineParams({ phase: { type: 'string', required: true, desc: 'Phase reference id currently shown in this PlanDetail View.' } }),
    }, async args => {
        const phase = resolvePhase(args.phase);
        if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Pass a currently shown Phase reference.' } };
        if (!await completePhase(phase.id)) return { success: false, error: { code: 'PHASE_COMPLETE_FAILED', message: 'Complete phase failed' } };
        return { success: true, data: { message: 'Phase completed.' } };
    });

    const [AddTaskTool] = useViewTypeTool('add_task', {
        description: 'Add a task to a Phase reference currently shown in this PlanDetail View.',
        params: defineParams({
            phase: { type: 'string', required: true, desc: 'Phase reference id currently shown in this PlanDetail View.' },
            title: { type: 'string', required: true, desc: 'Task title' },
            description: { type: 'string', required: false, desc: 'Optional task description' },
        }),
    }, async args => {
        const phase = resolvePhase(args.phase);
        if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Pass a currently shown Phase reference.' } };
        if (!await addTask(phase.id, args.title, args.description)) return { success: false, error: { code: 'TASK_ADD_FAILED', message: 'Add task failed' } };
        return { success: true, data: { message: 'Task added.' } };
    });

    const [UpdateTaskTool] = useViewTypeTool('update_task', {
        description: 'Update a Task reference currently shown in this PlanDetail View.',
        params: defineParams({
            task: { type: 'string', required: true, desc: 'Task reference id currently shown in this PlanDetail View.' },
            title: { type: 'string', required: false, desc: 'New task title' },
            description: { type: 'string', required: false, desc: 'New task description' },
        }),
    }, async args => {
        const task = resolveTask(args.task);
        if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Pass a currently shown Task reference.' } };
        if (!await updateTask(task.task.id, { title: args.title, description: args.description })) return { success: false, error: { code: 'TASK_UPDATE_FAILED', message: 'Update task failed' } };
        return { success: true, data: { message: 'Task updated.' } };
    });

    const [DeleteTaskTool] = useViewTypeTool('delete_task', {
        description: 'Delete a Task reference currently shown in this PlanDetail View.',
        params: defineParams({ task: { type: 'string', required: true, desc: 'Task reference id currently shown in this PlanDetail View.' } }),
    }, async args => {
        const task = resolveTask(args.task);
        if (!task || !plan.phases.some(phase => phase.id === task.phaseId)) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Pass a currently shown Task reference from this plan.' } };
        if (!await deleteTask(task.task.id)) return { success: false, error: { code: 'TASK_DELETE_FAILED', message: 'Delete task failed' } };
        return { success: true, data: { message: 'Task deleted.' } };
    });

    const [CompleteTaskTool] = useViewTypeTool('complete_task', {
        description: 'Complete a Task reference currently shown in this PlanDetail View.',
        params: defineParams({ task: { type: 'string', required: true, desc: 'Task reference id currently shown in this PlanDetail View.' } }),
    }, async args => {
        const task = resolveTask(args.task);
        if (!task || !plan.phases.some(phase => phase.id === task.phaseId)) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Pass a currently shown Task reference from this plan.' } };
        if (!await completeTask(task.task.id)) return { success: false, error: { code: 'TASK_COMPLETE_FAILED', message: 'Complete task failed' } };
        return { success: true, data: { message: 'Task completed.' } };
    });

    const PhaseTaskList = ({ refKey, tasks }: { refKey: string; tasks: TaskItem[] }) => {
        const [, phaseTaskRef] = useArrayRef(refKey, tasks, { itemType: 'Task' });
        if (tasks.length === 0) return <p>No tasks.</p>;
        return <ul>{tasks.map((task, index) => <li key={task.id}>{phaseTaskRef(index, task.title)}</li>)}</ul>;
    };

    return (
        <>
            <div>
                <h1>Plan Detail</h1>
                <h2>{planRef(plan.title)}</h2>
                {plan.description ? <p>{plan.description}</p> : null}

                <h3>Completed Phases</h3>
                {completed.length === 0 ? <p>No completed phases.</p> : (
                    <ul>{completed.map((phase, index) => <li key={phase.id}><div>{completedPhaseRef(index, phase.title)}</div></li>)}</ul>
                )}

                <h3>Current Phase</h3>
                {current ? <div>
                    <h4>{currentPhaseRef(current.title)}</h4>
                    {current.description ? <p>{current.description}</p> : null}
                    <h5>Pending Tasks</h5>
                    {pendingTasks.length === 0 ? <p>No pending tasks.</p> : <ul>{pendingTasks.map((task, index) => <li key={task.id}>{pendingTaskRef(index, task.title)}</li>)}</ul>}
                    <h5>Completed Tasks</h5>
                    {completedTasks.length === 0 ? <p>No completed tasks.</p> : <ul>{completedTasks.map((task, index) => <li key={task.id}>{completedTaskRef(index, task.title)}</li>)}</ul>}
                </div> : <p>No active phase. Add a phase to start.</p>}

                <h3>Upcoming Phases</h3>
                {upcoming.length === 0 ? <p>No upcoming phases.</p> : (
                    <ul>{upcoming.map((phase, index) => <li key={phase.id}>
                        <div>{upcomingPhaseRef(index, phase.title)}</div>
                        <PhaseTaskList refKey={`upcoming_phase_${index}_tasks`} tasks={phase.tasks} />
                    </li>)}</ul>
                )}
            </div>
            <div data-role="available-tools">
                <h2>PlanDetail View Tools</h2>
                <ul>
                    <li><AddPhaseTool /></li>
                    <li><DeletePhaseTool /></li>
                    <li><CompletePhaseTool /></li>
                    <li><AddTaskTool /></li>
                    <li><UpdateTaskTool /></li>
                    <li><DeleteTaskTool /></li>
                    <li><CompleteTaskTool /></li>
                </ul>
            </div>
        </>
    );
}
