import { defineViewType, refParam } from '@aotui/sdk';
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
    closePlan: () => Promise<void>;
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

function shownPlan(actions: PlanListActions, requestedId: string) {
    const plan = actions.plans.find(item => item.id === requestedId);
    if (!plan || (isPlanCompleted(plan) && plan.id !== actions.activePlan?.id)) return null;
    return plan;
}

function phaseFor(plan: Plan | null, phaseId: string) {
    const phase = plan?.phases.find(item => item.id === phaseId) ?? null;
    return { plan, phase };
}

function taskFor(plan: Plan | null, taskId: string) {
    const task = plan?.phases.flatMap(phase => phase.tasks).find(item => item.id === taskId) ?? null;
    return { plan, task };
}

const inactivePlan = () => ({ success: false as const, error: { code: 'PLAN_NOT_ACTIVE', message: 'Open the intended Plan and select a Ref from its current PlanDetail.' } });

export const RootType = defineViewType({ name: 'Root', multiplicity: 'single', region: 'static' });

export const PlanListType = defineViewType<PlanListActions>()({ name: 'PlanList', multiplicity: 'single', region: 'dynamic', tools: {
        create_plan: { description: 'Create a new plan, optionally with phases and tasks.',
            inputSchema: planInput,
            async execute({ input: args, context: actions }) {
                const phases: PhaseInput[] = (args.phases ?? []).map(({ title, description, tasks }) => ({
                    title, description, tasks: [...(tasks ?? [])],
                }));
                await actions.createPlan(args.title, args.description, phases);
                const taskCount = phases.reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
                return { success: true, data: { message: `Plan created with ${phases.length} phases and ${taskCount} tasks.` } };
            },
        },
        update_plan: { description: 'Update the Plan selected by a View-qualified Plan Ref from the current PlanList. The plan parameter is required.',
            inputSchema: updatePlanInput,
            async execute({ input: args, context: actions }) {
                const plan = shownPlan(actions, args.plan.id);
                if (!plan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Observe PlanList and select a current View-qualified Plan Ref for plan.' } };
                if (!await actions.updatePlan(plan.id, { title: args.title, description: args.description })) {
                    return { success: false, error: { code: 'PLAN_UPDATE_FAILED', message: 'Plan update failed' } };
                }
                return { success: true, data: { message: 'Plan updated.' } };
            },
        },
        delete_plan: { description: 'Delete the Plan selected by a View-qualified Plan Ref from the current PlanList. The plan parameter is required.',
            inputSchema: targetPlanInput,
            async execute({ input: args, context: actions }) {
                const plan = shownPlan(actions, args.plan.id);
                if (!plan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Observe PlanList and select a current View-qualified Plan Ref for plan.' } };
                if (!await actions.deletePlan(plan.id)) return { success: false, error: { code: 'PLAN_DELETE_FAILED', message: 'Plan delete failed' } };
                return { success: true, data: { message: 'Plan deleted.' } };
            },
        },
        open_plan: { description: 'Open a current unfinished Plan using its View-qualified Plan Ref name from PlanList.',
            inputSchema: targetPlanInput,
            async execute({ input: { plan }, context: actions }) {
                if (!shownPlan(actions, plan.id)) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Refresh PlanList and select a current View-qualified Plan Ref name for plan.' } };
                if (!await actions.openPlan(plan.id)) return { success: false, error: { code: 'PLAN_OPEN_FAILED', message: 'Plan open failed' } };
                return { success: true, data: { message: 'Plan opened.' } };
            },
        },
        close_plan: { description: 'Close the active plan.',
            inputSchema: emptyInput,
            enabled: ({ activePlan }) => Boolean(activePlan),
            async execute({ context: actions }) {
                if (!actions.activePlan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'There is no active plan to close.' } };
                await actions.closePlan();
                return { success: true, data: { message: 'Active plan closed.' } };
            },
        },
} });

export const PlanDetailType = defineViewType<PlanDetailActions>()({ name: 'PlanDetail', multiplicity: 'single', region: 'dynamic', tools: {
        add_phase: { description: 'Add a phase to the active Plan selected by its View-qualified Plan Ref, optionally with initial tasks.',
            inputSchema: addPhaseInput,
            async execute({ input: args, context: actions }) {
                if (!findActivePlan(actions.activePlan, args.plan.id)) return inactivePlan();
                const tasks = [...(args.tasks ?? [])];
                if (!await actions.addPhase(args.title, args.description, tasks)) return { success: false, error: { code: 'PHASE_ADD_FAILED', message: 'Add phase failed' } };
                return { success: true, data: { message: `Phase added with ${tasks.length} tasks.` } };
            },
        },
        delete_phase: { description: 'Delete the Phase selected by a View-qualified Phase Ref in the active PlanDetail.',
            inputSchema: planDetailPhaseInput,
            async execute({ input: args, context: actions }) {
                const { plan, phase } = phaseFor(actions.activePlan, args.phase.id);
                if (!plan) return inactivePlan();
                if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Phase Ref from that Plan.' } };
                if (!await actions.deletePhase(phase.id)) return { success: false, error: { code: 'PHASE_DELETE_FAILED', message: 'Phase delete failed' } };
                return { success: true, data: { message: 'Phase deleted.' } };
            },
        },
        complete_phase: { description: 'Complete the Phase selected by a View-qualified Phase Ref in the active PlanDetail.',
            inputSchema: planDetailPhaseInput,
            async execute({ input: args, context: actions }) {
                const { plan, phase } = phaseFor(actions.activePlan, args.phase.id);
                if (!plan) return inactivePlan();
                if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Phase Ref from that Plan.' } };
                if (!await actions.completePhase(phase.id)) return { success: false, error: { code: 'PHASE_COMPLETE_FAILED', message: 'Complete phase failed' } };
                return { success: true, data: { message: 'Phase completed.' } };
            },
        },
        add_task: { description: 'Add a task to the Phase selected by a View-qualified Phase Ref in the active PlanDetail.',
            inputSchema: addTaskInput,
            async execute({ input: args, context: actions }) {
                const { plan, phase } = phaseFor(actions.activePlan, args.phase.id);
                if (!plan) return inactivePlan();
                if (!phase) return { success: false, error: { code: 'PHASE_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Phase Ref from that Plan.' } };
                if (!await actions.addTask(phase.id, args.title, args.description)) return { success: false, error: { code: 'TASK_ADD_FAILED', message: 'Add task failed' } };
                return { success: true, data: { message: 'Task added.' } };
            },
        },
        update_task: { description: 'Update the Task selected by a View-qualified Task Ref in the active PlanDetail.',
            inputSchema: updateTaskInput,
            async execute({ input: args, context: actions }) {
                const { plan, task } = taskFor(actions.activePlan, args.task.id);
                if (!plan) return inactivePlan();
                if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Task Ref from that Plan.' } };
                if (!await actions.updateTask(task.id, { title: args.title, description: args.description })) return { success: false, error: { code: 'TASK_UPDATE_FAILED', message: 'Update task failed' } };
                return { success: true, data: { message: 'Task updated.' } };
            },
        },
        delete_task: { description: 'Delete the Task selected by a View-qualified Task Ref in the active PlanDetail.',
            inputSchema: planDetailTaskInput,
            async execute({ input: args, context: actions }) {
                const { plan, task } = taskFor(actions.activePlan, args.task.id);
                if (!plan) return inactivePlan();
                if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Task Ref from that Plan.' } };
                if (!await actions.deleteTask(task.id)) return { success: false, error: { code: 'TASK_DELETE_FAILED', message: 'Delete task failed' } };
                return { success: true, data: { message: 'Task deleted.' } };
            },
        },
        complete_task: { description: 'Complete the Task selected by a View-qualified Task Ref in the active PlanDetail.',
            inputSchema: planDetailTaskInput,
            async execute({ input: args, context: actions }) {
                const { plan, task } = taskFor(actions.activePlan, args.task.id);
                if (!plan) return inactivePlan();
                if (!task) return { success: false, error: { code: 'TASK_NOT_FOUND', message: 'Observe the active PlanDetail and select a current View-qualified Task Ref from that Plan.' } };
                if (!await actions.completeTask(task.id)) return { success: false, error: { code: 'TASK_COMPLETE_FAILED', message: 'Complete task failed' } };
                return { success: true, data: { message: 'Task completed.' } };
            },
        },
} });

export const planningViewTypes = [RootType, PlanListType, PlanDetailType] as const;
