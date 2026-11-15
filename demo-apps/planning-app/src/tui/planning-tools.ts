import { defineViewType, refParam, type ArgsOf, type ToolBinding } from '@aotui/sdk';
import Type from 'typebox';
import { PlanSchema, PhaseSchema, TaskSchema } from './ref-schemas.js';
import type { PhaseInput, Plan, TaskInput } from '../types.js';

const taskInput = Type.Object({
    title: Type.String(),
    description: Type.Optional(Type.String()),
});
const tasksInput = Type.Array(taskInput, { description: 'Initial tasks for this phase.' });
const phaseInput = Type.Object({
    title: Type.String(),
    description: Type.Optional(Type.String()),
    tasks: Type.Optional(tasksInput),
}, { additionalProperties: false });
const planInput = Type.Object({
    title: Type.String({ description: 'Plan title' }),
    description: Type.Optional(Type.String({ description: 'Optional plan description' })),
    phases: Type.Optional(Type.Array(phaseInput, { description: 'Initial phases for the plan.' })),
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
    tasks: Type.Optional(tasksInput),
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
        create_plan: ({ execute: async (args: ArgsOf<typeof PlanListType.tools.create_plan>) => {
                const phases: PhaseInput[] = (args.phases ?? []).map(({ title, description, tasks }) => ({
                    title, description, tasks: [...(tasks ?? [])],
                }));
                await actions.createPlan(args.title, args.description, phases);
                const taskCount = phases.reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
                return { success: true, data: { message: `Plan created with ${phases.length} phases and ${taskCount} tasks.` } };
            } } satisfies ToolBinding<typeof PlanListType.tools.create_plan>),
        update_plan: ({ execute: async (args: ArgsOf<typeof PlanListType.tools.update_plan>) => {
                const plan = shownPlan(args.plan.id);
                if (!plan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Observe PlanList and select a current View-qualified Plan Ref for plan.' } };
                if (!await actions.updatePlan(plan.id, { title: args.title, description: args.description })) {
                    return { success: false, error: { code: 'PLAN_UPDATE_FAILED', message: 'Plan update failed' } };
                }
                return { success: true, data: { message: 'Plan updated.' } };
            } } satisfies ToolBinding<typeof PlanListType.tools.update_plan>),
        delete_plan: ({ execute: async (args: ArgsOf<typeof PlanListType.tools.delete_plan>) => {
                const plan = shownPlan(args.plan.id);
                if (!plan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Observe PlanList and select a current View-qualified Plan Ref for plan.' } };
                if (!await actions.deletePlan(plan.id)) return { success: false, error: { code: 'PLAN_DELETE_FAILED', message: 'Plan delete failed' } };
                return { success: true, data: { message: 'Plan deleted.' } };
            } } satisfies ToolBinding<typeof PlanListType.tools.delete_plan>),
        open_plan: ({ execute: async ({ plan }: ArgsOf<typeof PlanListType.tools.open_plan>) => {
                if (!shownPlan(plan.id)) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Refresh PlanList and select a current View-qualified Plan Ref name for plan.' } };
                if (!await actions.openPlan(plan.id)) return { success: false, error: { code: 'PLAN_OPEN_FAILED', message: 'Plan open failed' } };
                return { success: true, data: { message: 'Plan opened.' } };
            } } satisfies ToolBinding<typeof PlanListType.tools.open_plan>),
        close_plan: ({ execute: async () => {
                if (!actions.activePlan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'There is no active plan to close.' } };
                actions.closePlan();
                return { success: true, data: { message: 'Active plan closed.' } };
            } } satisfies ToolBinding<typeof PlanListType.tools.close_plan>),
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
        add_phase: ({ execute: async (args: ArgsOf<typeof PlanDetailType.tools.add_phase>) => {
                if (!findActivePlan(actions.activePlan, args.plan.id)) return inactivePlan();
                const tasks = [...(args.tasks ?? [])];
                if (!await actions.addPhase(args.title, args.description, tasks)) return { success: false, error: { code: 'PHASE_ADD_FAILED', message: 'Add phase failed' } };
                return { success: true, data: { message: `Phase added with ${tasks.length} tasks.` } };
            } } satisfies ToolBinding<typeof PlanDetailType.tools.add_phase>),
        delete_phase: ({ execute: async (args: ArgsOf<typeof PlanDetailType.tools.delete_phase>) => {
                const { plan, phase } = phaseFor(args.phase.id);
                if (!plan) return inactivePlan();
                if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Phase Ref from that Plan.' } };
                if (!await actions.deletePhase(phase.id)) return { success: false, error: { code: 'PHASE_DELETE_FAILED', message: 'Phase delete failed' } };
                return { success: true, data: { message: 'Phase deleted.' } };
            } } satisfies ToolBinding<typeof PlanDetailType.tools.delete_phase>),
        complete_phase: ({ execute: async (args: ArgsOf<typeof PlanDetailType.tools.complete_phase>) => {
                const { plan, phase } = phaseFor(args.phase.id);
                if (!plan) return inactivePlan();
                if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Phase Ref from that Plan.' } };
                if (!await actions.completePhase(phase.id)) return { success: false, error: { code: 'PHASE_COMPLETE_FAILED', message: 'Complete phase failed' } };
                return { success: true, data: { message: 'Phase completed.' } };
            } } satisfies ToolBinding<typeof PlanDetailType.tools.complete_phase>),
        add_task: ({ execute: async (args: ArgsOf<typeof PlanDetailType.tools.add_task>) => {
                const { plan, phase } = phaseFor(args.phase.id);
                if (!plan) return inactivePlan();
                if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Phase Ref from that Plan.' } };
                if (!await actions.addTask(phase.id, args.title, args.description)) return { success: false, error: { code: 'TASK_ADD_FAILED', message: 'Add task failed' } };
                return { success: true, data: { message: 'Task added.' } };
            } } satisfies ToolBinding<typeof PlanDetailType.tools.add_task>),
        update_task: ({ execute: async (args: ArgsOf<typeof PlanDetailType.tools.update_task>) => {
                const { plan, task } = taskFor(args.task.id);
                if (!plan) return inactivePlan();
                if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Task Ref from that Plan.' } };
                if (!await actions.updateTask(task.id, { title: args.title, description: args.description })) return { success: false, error: { code: 'TASK_UPDATE_FAILED', message: 'Update task failed' } };
                return { success: true, data: { message: 'Task updated.' } };
            } } satisfies ToolBinding<typeof PlanDetailType.tools.update_task>),
        delete_task: ({ execute: async (args: ArgsOf<typeof PlanDetailType.tools.delete_task>) => {
                const { plan, task } = taskFor(args.task.id);
                if (!plan) return inactivePlan();
                if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Task Ref from that Plan.' } };
                if (!await actions.deleteTask(task.id)) return { success: false, error: { code: 'TASK_DELETE_FAILED', message: 'Delete task failed' } };
                return { success: true, data: { message: 'Task deleted.' } };
            } } satisfies ToolBinding<typeof PlanDetailType.tools.delete_task>),
        complete_task: ({ execute: async (args: ArgsOf<typeof PlanDetailType.tools.complete_task>) => {
                const { plan, task } = taskFor(args.task.id);
                if (!plan) return inactivePlan();
                if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Task Ref from that Plan.' } };
                if (!await actions.completeTask(task.id)) return { success: false, error: { code: 'TASK_COMPLETE_FAILED', message: 'Complete task failed' } };
                return { success: true, data: { message: 'Task completed.' } };
            } } satisfies ToolBinding<typeof PlanDetailType.tools.complete_task>),
    };
}

export const RootType = defineViewType({ name: 'Root', tools: {} });

export const PlanListType = defineViewType({ name: 'PlanList', tools: {
        create_plan: { description: 'Create a new plan, optionally with phases and tasks.',
            inputSchema: planInput,
        },
        update_plan: { description: 'Update the Plan selected by a View-qualified Plan Ref from the current PlanList. The plan parameter is required.',
            inputSchema: updatePlanInput,
        },
        delete_plan: { description: 'Delete the Plan selected by a View-qualified Plan Ref from the current PlanList. The plan parameter is required.',
            inputSchema: targetPlanInput,
        },
        open_plan: { description: 'Open a current unfinished Plan using its View-qualified Plan Ref name from PlanList.',
            inputSchema: targetPlanInput,
        },
        close_plan: { description: 'Close the active plan.',
            inputSchema: emptyInput,
        },
} });

export const PlanDetailType = defineViewType({ name: 'PlanDetail', tools: {
        add_phase: { description: 'Add a phase to the active Plan selected by its View-qualified Plan Ref, optionally with initial tasks.',
            inputSchema: addPhaseInput,
        },
        delete_phase: { description: 'Delete the Phase selected by a View-qualified Phase Ref in the active PlanDetail.',
            inputSchema: planDetailPhaseInput,
        },
        complete_phase: { description: 'Complete the Phase selected by a View-qualified Phase Ref in the active PlanDetail.',
            inputSchema: planDetailPhaseInput,
        },
        add_task: { description: 'Add a task to the Phase selected by a View-qualified Phase Ref in the active PlanDetail.',
            inputSchema: addTaskInput,
        },
        update_task: { description: 'Update the Task selected by a View-qualified Task Ref in the active PlanDetail.',
            inputSchema: updateTaskInput,
        },
        delete_task: { description: 'Delete the Task selected by a View-qualified Task Ref in the active PlanDetail.',
            inputSchema: planDetailTaskInput,
        },
        complete_task: { description: 'Complete the Task selected by a View-qualified Task Ref in the active PlanDetail.',
            inputSchema: planDetailTaskInput,
        },
} });

export const planningViewTypes = [RootType, PlanListType, PlanDetailType] as const;
