import { defineViewTypeTool, defineToolSet, refParam, type ArgsOf, type ToolBinding } from '@aotui/sdk';
import Type from 'typebox';
import { PlanSchema, PhaseSchema, TaskSchema } from './ref-schemas.js';
import type { PhaseInput, Plan, TaskInput } from '../types.js';

const looseObject = Type.Object({}, { additionalProperties: true });
const planInput = Type.Object({
    title: Type.String({ description: 'Plan title' }),
    description: Type.Optional(Type.String({ description: 'Optional plan description' })),
    phases: Type.Optional(Type.Array(looseObject, { description: 'Optional phase objects with title, description, and tasks or todos.' })),
}, { additionalProperties: false });

const updatePlanInput = Type.Object({
    plan: refParam('Plan', PlanSchema),
    title: Type.Optional(Type.String({ description: 'New plan title' })),
    description: Type.Optional(Type.String({ description: 'New plan description' })),
}, { additionalProperties: false });

const targetPlanInput = Type.Object({
    plan: refParam('Plan', PlanSchema),
}, { additionalProperties: false });

const emptyInput = Type.Object({}, { additionalProperties: false });

const planDetailPhaseInput = Type.Object({
    phase: refParam('Phase', PhaseSchema),
}, { additionalProperties: false });

const addPhaseInput = Type.Object({
    plan: refParam('Plan', PlanSchema),
    title: Type.String({ description: 'Phase title' }),
    description: Type.Optional(Type.String({ description: 'Optional phase description' })),
    tasks: Type.Optional(Type.Array(looseObject, { description: 'Initial tasks: objects with a required title and optional description.' })),
}, { additionalProperties: false });

const addTaskInput = Type.Object({
    phase: refParam('Phase', PhaseSchema),
    title: Type.String({ description: 'Task title' }),
    description: Type.Optional(Type.String({ description: 'Optional task description' })),
}, { additionalProperties: false });

const planDetailTaskInput = Type.Object({
    task: refParam('Task', TaskSchema),
}, { additionalProperties: false });

const updateTaskInput = Type.Object({
    task: refParam('Task', TaskSchema),
    title: Type.Optional(Type.String({ description: 'New task title' })),
    description: Type.Optional(Type.String({ description: 'New task description' })),
}, { additionalProperties: false });

type PlanListActions = {
    plans: Plan[];
    activePlan: Plan | null;
    createPlan: (title: string, description?: string, phases?: PhaseInput[]) => Promise<string>;
    updatePlan: (planId: string, updates: { title?: string; description?: string }) => Promise<boolean>;
    deletePlan: (planId: string) => Promise<boolean>;
    openPlan: (planId: string) => Promise<boolean>;
    closePlan: () => void;
};

type PlanDetailActions = {
    activePlan: Plan | null;
    addPhase: (title: string, description?: string, tasks?: TaskInput[]) => Promise<string | null>;
    deletePhase: (phaseId: string) => Promise<boolean>;
    completePhase: (phaseId: string) => Promise<boolean>;
    addTask: (phaseId: string, title: string, description?: string) => Promise<string | null>;
    updateTask: (taskId: string, updates: { title?: string; description?: string }) => Promise<boolean>;
    deleteTask: (taskId: string) => Promise<boolean>;
    completeTask: (taskId: string) => Promise<boolean>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseTaskInputs(value: unknown): TaskInput[] | null {
    if (!Array.isArray(value)) return null;
    const tasks: TaskInput[] = [];
    for (const item of value) {
        if (!isRecord(item) || typeof item.title !== 'string') return null;
        if (item.description !== undefined && typeof item.description !== 'string') return null;
        tasks.push({ title: item.title, description: item.description });
    }
    return tasks;
}

function parsePhaseInputs(value: unknown): PhaseInput[] | null {
    if (!Array.isArray(value)) return null;
    const phases: PhaseInput[] = [];
    for (const item of value) {
        if (!isRecord(item) || typeof item.title !== 'string') return null;
        if (item.description !== undefined && typeof item.description !== 'string') return null;
        const phase: PhaseInput = { title: item.title, description: item.description };
        const tasks = item.tasks ?? item.todos;
        if (tasks !== undefined) {
            const parsedTasks = parseTaskInputs(tasks);
            if (!parsedTasks) return null;
            phase.tasks = parsedTasks;
        }
        phases.push(phase);
    }
    return phases;
}

function findActivePlan(plan: Plan | null, requestedPlanId: string): Plan | null {
    return plan?.id === requestedPlanId ? plan : null;
}

function isPlanCompleted(plan: Plan): boolean {
    return plan.phases.length > 0 && plan.phases.every(phase => phase.status === 'completed');
}

export function createPlanListBindings(actions: PlanListActions) {
    const shownPlan = (requestedId: string) => {
        const plan = actions.plans.find(item => item.id === requestedId);
        if (!plan || (isPlanCompleted(plan) && plan.id !== actions.activePlan?.id)) return null;
        return plan;
    };
    return {
        createPlan: ({ execute: async (args: ArgsOf<typeof planningTools.createPlan>) => {
                const phases = args.phases === undefined ? [] : parsePhaseInputs(args.phases);
                if (!phases) {
                    return { success: false, error: { code: 'INVALID_PHASES', message: 'Each phase needs a string title; descriptions and task titles must be strings.' } };
                }
                await actions.createPlan(args.title, args.description, phases);
                const taskCount = phases.reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
                return { success: true, data: { message: `Plan created with ${phases.length} phases and ${taskCount} tasks.` } };
            } } satisfies ToolBinding<typeof planningTools.createPlan>),
        updatePlan: ({ execute: async (args: ArgsOf<typeof planningTools.updatePlan>) => {
                const plan = shownPlan(args.plan.id);
                if (!plan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Observe PlanList and select a current View-qualified Plan Ref for plan.' } };
                if (!await actions.updatePlan(plan.id, { title: args.title, description: args.description })) {
                    return { success: false, error: { code: 'PLAN_UPDATE_FAILED', message: 'Plan update failed' } };
                }
                return { success: true, data: { message: 'Plan updated.' } };
            } } satisfies ToolBinding<typeof planningTools.updatePlan>),
        deletePlan: ({ execute: async (args: ArgsOf<typeof planningTools.deletePlan>) => {
                const plan = shownPlan(args.plan.id);
                if (!plan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Observe PlanList and select a current View-qualified Plan Ref for plan.' } };
                if (!await actions.deletePlan(plan.id)) return { success: false, error: { code: 'PLAN_DELETE_FAILED', message: 'Plan delete failed' } };
                return { success: true, data: { message: 'Plan deleted.' } };
            } } satisfies ToolBinding<typeof planningTools.deletePlan>),
        openPlan: ({ execute: async ({ plan }: ArgsOf<typeof planningTools.openPlan>) => {
                if (!shownPlan(plan.id)) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Refresh PlanList and select a current View-qualified Plan Ref name for plan.' } };
                if (!await actions.openPlan(plan.id)) return { success: false, error: { code: 'PLAN_OPEN_FAILED', message: 'Plan open failed' } };
                return { success: true, data: { message: 'Plan opened.' } };
            } } satisfies ToolBinding<typeof planningTools.openPlan>),
        closePlan: ({ execute: async () => {
                if (!actions.activePlan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'There is no active plan to close.' } };
                actions.closePlan();
                return { success: true, data: { message: 'Active plan closed.' } };
            } } satisfies ToolBinding<typeof planningTools.closePlan>),
    };
}

export function createPlanDetailBindings(actions: PlanDetailActions) {
    const phaseFor = (phaseId: string) => {
        const plan = actions.activePlan;
        const phase = plan?.phases.find(item => item.id === phaseId) ?? null;
        return { plan, phase };
    };
    const taskFor = (taskId: string) => {
        const plan = actions.activePlan;
        const task = plan?.phases.flatMap(phase => phase.tasks).find(item => item.id === taskId) ?? null;
        return { plan, task };
    };
    const inactivePlan = () => ({ success: false as const, error: { code: 'PLAN_NOT_ACTIVE', message: 'Open the intended Plan and select a Ref from its current PlanDetail.' } });

    return {
        addPhase: ({ execute: async (args: ArgsOf<typeof planningTools.addPhase>) => {
                if (!findActivePlan(actions.activePlan, args.plan.id)) return inactivePlan();
                const tasks = args.tasks === undefined ? [] : parseTaskInputs(args.tasks);
                if (!tasks) return { success: false, error: { code: 'INVALID_TASKS', message: 'Each task needs a string title and an optional string description.' } };
                if (!await actions.addPhase(args.title, args.description, tasks)) return { success: false, error: { code: 'PHASE_ADD_FAILED', message: 'Add phase failed' } };
                return { success: true, data: { message: `Phase added with ${tasks.length} tasks.` } };
            } } satisfies ToolBinding<typeof planningTools.addPhase>),
        deletePhase: ({ execute: async (args: ArgsOf<typeof planningTools.deletePhase>) => {
                const { plan, phase } = phaseFor(args.phase.id);
                if (!plan) return inactivePlan();
                if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Phase Ref from that Plan.' } };
                if (!await actions.deletePhase(phase.id)) return { success: false, error: { code: 'PHASE_DELETE_FAILED', message: 'Phase delete failed' } };
                return { success: true, data: { message: 'Phase deleted.' } };
            } } satisfies ToolBinding<typeof planningTools.deletePhase>),
        completePhase: ({ execute: async (args: ArgsOf<typeof planningTools.completePhase>) => {
                const { plan, phase } = phaseFor(args.phase.id);
                if (!plan) return inactivePlan();
                if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Phase Ref from that Plan.' } };
                if (!await actions.completePhase(phase.id)) return { success: false, error: { code: 'PHASE_COMPLETE_FAILED', message: 'Complete phase failed' } };
                return { success: true, data: { message: 'Phase completed.' } };
            } } satisfies ToolBinding<typeof planningTools.completePhase>),
        addTask: ({ execute: async (args: ArgsOf<typeof planningTools.addTask>) => {
                const { plan, phase } = phaseFor(args.phase.id);
                if (!plan) return inactivePlan();
                if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Phase Ref from that Plan.' } };
                if (!await actions.addTask(phase.id, args.title, args.description)) return { success: false, error: { code: 'TASK_ADD_FAILED', message: 'Add task failed' } };
                return { success: true, data: { message: 'Task added.' } };
            } } satisfies ToolBinding<typeof planningTools.addTask>),
        updateTask: ({ execute: async (args: ArgsOf<typeof planningTools.updateTask>) => {
                const { plan, task } = taskFor(args.task.id);
                if (!plan) return inactivePlan();
                if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Task Ref from that Plan.' } };
                if (!await actions.updateTask(task.id, { title: args.title, description: args.description })) return { success: false, error: { code: 'TASK_UPDATE_FAILED', message: 'Update task failed' } };
                return { success: true, data: { message: 'Task updated.' } };
            } } satisfies ToolBinding<typeof planningTools.updateTask>),
        deleteTask: ({ execute: async (args: ArgsOf<typeof planningTools.deleteTask>) => {
                const { plan, task } = taskFor(args.task.id);
                if (!plan) return inactivePlan();
                if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Task Ref from that Plan.' } };
                if (!await actions.deleteTask(task.id)) return { success: false, error: { code: 'TASK_DELETE_FAILED', message: 'Delete task failed' } };
                return { success: true, data: { message: 'Task deleted.' } };
            } } satisfies ToolBinding<typeof planningTools.deleteTask>),
        completeTask: ({ execute: async (args: ArgsOf<typeof planningTools.completeTask>) => {
                const { plan, task } = taskFor(args.task.id);
                if (!plan) return inactivePlan();
                if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Task Ref from that Plan.' } };
                if (!await actions.completeTask(task.id)) return { success: false, error: { code: 'TASK_COMPLETE_FAILED', message: 'Complete task failed' } };
                return { success: true, data: { message: 'Task completed.' } };
            } } satisfies ToolBinding<typeof planningTools.completeTask>),
    };
}

export const planningTools = defineToolSet({
createPlan: defineViewTypeTool({
            viewType: 'PlanList',
            name: 'create_plan',
            description: 'Create a new plan, optionally with phases and tasks.',
            inputSchema: planInput,
        }),
updatePlan: defineViewTypeTool({
            viewType: 'PlanList',
            name: 'update_plan',
            description: 'Update the Plan selected by a View-qualified Plan Ref from the current PlanList. The plan parameter is required.',
            inputSchema: updatePlanInput,
        }),
deletePlan: defineViewTypeTool({
            viewType: 'PlanList',
            name: 'delete_plan',
            description: 'Delete the Plan selected by a View-qualified Plan Ref from the current PlanList. The plan parameter is required.',
            inputSchema: targetPlanInput,
        }),
openPlan: defineViewTypeTool({
            viewType: 'PlanList',
            name: 'open_plan',
            description: 'Open a current unfinished Plan using its View-qualified Plan Ref name from PlanList.',
            inputSchema: targetPlanInput,
        }),
closePlan: defineViewTypeTool({
            viewType: 'PlanList',
            name: 'close_plan',
            description: 'Close the active plan.',
            inputSchema: emptyInput,
        }),
addPhase: defineViewTypeTool({
            viewType: 'PlanDetail',
            name: 'add_phase',
            description: 'Add a phase to the active Plan selected by its View-qualified Plan Ref, optionally with initial tasks.',
            inputSchema: addPhaseInput,
        }),
deletePhase: defineViewTypeTool({
            viewType: 'PlanDetail',
            name: 'delete_phase',
            description: 'Delete the Phase selected by a View-qualified Phase Ref in the active PlanDetail.',
            inputSchema: planDetailPhaseInput,
        }),
completePhase: defineViewTypeTool({
            viewType: 'PlanDetail',
            name: 'complete_phase',
            description: 'Complete the Phase selected by a View-qualified Phase Ref in the active PlanDetail.',
            inputSchema: planDetailPhaseInput,
        }),
addTask: defineViewTypeTool({
            viewType: 'PlanDetail',
            name: 'add_task',
            description: 'Add a task to the Phase selected by a View-qualified Phase Ref in the active PlanDetail.',
            inputSchema: addTaskInput,
        }),
updateTask: defineViewTypeTool({
            viewType: 'PlanDetail',
            name: 'update_task',
            description: 'Update the Task selected by a View-qualified Task Ref in the active PlanDetail.',
            inputSchema: updateTaskInput,
        }),
deleteTask: defineViewTypeTool({
            viewType: 'PlanDetail',
            name: 'delete_task',
            description: 'Delete the Task selected by a View-qualified Task Ref in the active PlanDetail.',
            inputSchema: planDetailTaskInput,
        }),
completeTask: defineViewTypeTool({
            viewType: 'PlanDetail',
            name: 'complete_task',
            description: 'Complete the Task selected by a View-qualified Task Ref in the active PlanDetail.',
            inputSchema: planDetailTaskInput,
        })
});
