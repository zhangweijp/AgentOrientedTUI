import { useArrayRef, useDataRef, useViewTypeTool } from '@aotui/sdk';
import type { PhaseInput, Plan } from '../types.js';

type PlanListViewProps = {
    plans: Plan[];
    activePlanId: string | null;
    createPlan: (title: string, description?: string, phases?: PhaseInput[]) => Promise<string>;
    updatePlan: (planId: string, updates: { title?: string; description?: string }) => Promise<boolean>;
    deletePlan: (planId: string) => Promise<boolean>;
    openPlan: (planId: string) => Promise<boolean>;
    closePlan: () => void;
};

const isPlanCompleted = (plan: Plan) => plan.phases.length > 0 && plan.phases.every(phase => phase.status === 'completed');
export function PlanListView({ plans, activePlanId, createPlan, updatePlan, deletePlan, openPlan, closePlan }: PlanListViewProps) {
    const unfinishedPlans = plans.filter(plan => !isPlanCompleted(plan));
    const activePlan = plans.find(plan => plan.id === activePlanId) || null;
    const planByRef = new Map<string, Plan>();
    if (activePlan) planByRef.set('active_plan', activePlan);
    unfinishedPlans.forEach((plan, index) => {
        planByRef.set(`Plan:unfinished_plans[${index}]`, plan);
    });
    const resolvePlan = (refId?: string) => refId ? planByRef.get(refId) ?? null : null;

    const activePlanRef = useDataRef('active_plan', activePlan ?? { title: 'No Active Plan' });
    const [, unfinishedPlanRef] = useArrayRef('unfinished_plans', unfinishedPlans, { itemType: 'Plan' });

    const [CreatePlanTool] = useViewTypeTool('create_plan', {
        description: 'Create a new plan, optionally with phases and tasks.',
        params: {
            title: { type: 'string', required: true, desc: 'Plan title' },
            description: { type: 'string', required: false, desc: 'Optional plan description' },
            phases: {
                type: 'array', required: false, itemType: 'object',
                desc: 'Phases with tasks: [{ title, description?, tasks?: [{ title, description? }] }]',
            },
        },
    }, async args => {
        const phases = (args.phases ?? []) as unknown as PhaseInput[];
        await createPlan(args.title, args.description, phases);
        const taskCount = phases.reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
        return { success: true, data: { message: `Plan created with ${phases.length} phases and ${taskCount} tasks.` } };
    });

    const [UpdatePlanTool] = useViewTypeTool('update_plan', {
        description: 'Update a shown Plan reference. Omit plan to use the active plan.',
        params: {
            plan: { type: 'string', required: false, desc: 'Reference id currently shown in PlanList; omit to use the active plan.' },
            title: { type: 'string', required: false, desc: 'New plan title' },
            description: { type: 'string', required: false, desc: 'New plan description' },
        },
    }, async args => {
        const plan = args.plan ? resolvePlan(args.plan) : activePlan;
        if (!plan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Pass a currently shown Plan reference or open a plan first.' } };
        if (!await updatePlan(plan.id, { title: args.title, description: args.description })) {
            return { success: false, error: { code: 'PLAN_UPDATE_FAILED', message: 'Plan update failed' } };
        }
        return { success: true, data: { message: 'Plan updated.' } };
    });

    const [DeletePlanTool] = useViewTypeTool('delete_plan', {
        description: 'Delete a shown Plan reference. Omit plan to use the active plan.',
        params: { plan: { type: 'string', required: false, desc: 'Reference id currently shown in PlanList; omit to use the active plan.' } },
    }, async args => {
        const plan = args.plan ? resolvePlan(args.plan) : activePlan;
        if (!plan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Pass a currently shown Plan reference or open a plan first.' } };
        if (!await deletePlan(plan.id)) return { success: false, error: { code: 'PLAN_DELETE_FAILED', message: 'Plan delete failed' } };
        return { success: true, data: { message: 'Plan deleted.' } };
    });

    const [OpenPlanTool] = useViewTypeTool('open_plan', {
        description: 'Open a plan using a Plan reference currently shown in this View.',
        params: { plan: { type: 'string', required: true, desc: 'Plan reference id currently shown in PlanList.' } },
    }, async args => {
        const plan = resolvePlan(args.plan);
        if (!plan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Pass a currently shown Plan reference.' } };
        if (!await openPlan(plan.id)) return { success: false, error: { code: 'PLAN_OPEN_FAILED', message: 'Plan open failed' } };
        return { success: true, data: { message: 'Plan opened.' } };
    });

    const [ClosePlanTool] = useViewTypeTool('close_plan', {
        description: 'Close the active plan.',
        params: {},
    }, async () => {
        if (!activePlan) return { success: false, error: { code: 'PLAN_NOT_FOUND', message: 'There is no active plan to close.' } };
        closePlan();
        return { success: true, data: { message: 'Active plan closed.' } };
    }, { enabled: Boolean(activePlan) });

    return (
        <>
            <div>
                <h1>Plan List</h1>
                <p>Only one plan can be open at a time.</p>
                {activePlan ? <><h2>Active Plan</h2><p>{activePlanRef(activePlan.title)}</p></> : <p>No active plan.</p>}
                <h2>Unfinished Plans</h2>
                {unfinishedPlans.length === 0 ? <p>No unfinished plans.</p> : (
                    <ul>{unfinishedPlans.map((plan, index) => {
                        const completedCount = plan.phases.filter(phase => phase.status === 'completed').length;
                        return <li key={plan.id}>
                            <div><strong>{unfinishedPlanRef(index, plan.title)}</strong></div>
                            <div>Phases completed: {completedCount}/{plan.phases.length}</div>
                            {plan.description ? <div>{plan.description}</div> : null}
                        </li>;
                    })}</ul>
                )}
            </div>
            <div data-role="available-tools">
                <h2>PlanList View Tools</h2>
                <ul>
                    <li><CreatePlanTool /></li>
                    <li><UpdatePlanTool /></li>
                    <li><DeletePlanTool /></li>
                    <li><OpenPlanTool /></li>
                    <li><ClosePlanTool /></li>
                </ul>
            </div>
        </>
    );
}
