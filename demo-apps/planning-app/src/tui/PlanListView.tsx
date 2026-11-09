import { useArrayRef, useDataRef } from '@aotui/sdk';
import type { Plan } from '../types.js';

type PlanListViewProps = {
    plans: Plan[];
    activePlan: Plan | null;
};

const isPlanCompleted = (plan: Plan) => plan.phases.length > 0 && plan.phases.every(phase => phase.status === 'completed');

function ActivePlan({ plan }: { plan: Plan }) {
    const planRef = useDataRef('active_plan', plan, { refType: 'Plan' });
    return <><h2>Active Plan</h2><p>{planRef(plan.title)}</p></>;
}

export function PlanListView({ plans, activePlan }: PlanListViewProps) {
    const unfinishedPlans = plans.filter(plan => !isPlanCompleted(plan));
    const [, unfinishedPlanRef] = useArrayRef('unfinished_plans', unfinishedPlans, { itemType: 'Plan' });

    return (
        <>
            <div>
                <h1>Plan List</h1>
                <p>Only one plan can be open at a time.</p>
                {activePlan ? <ActivePlan plan={activePlan} /> : <p>No active plan.</p>}
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
        </>
    );
}
