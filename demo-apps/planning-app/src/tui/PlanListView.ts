import Type from 'typebox';
import { arrayRef, formatRef, ref, type PublishedRef } from '@aotui/sdk';
import type { Plan } from '../types.js';
import { PlanSchema } from './ref-schemas.js';

const PlanList = Type.Array(PlanSchema);

export function planListContent(plans: Plan[], activePlan: Plan | null): { body: string; refs: PublishedRef[] } {
    const unfinishedPlans = plans.filter(plan => !plan.phases.length || plan.phases.some(phase => phase.status !== 'completed'));
    const unfinished = arrayRef('unfinished_plans', unfinishedPlans, { scope: 'private', itemType: 'Plan', schema: PlanList });
    const refs: PublishedRef[] = [unfinished];
    let active = 'No active plan.';
    if (activePlan) {
        const selected = ref('active_plan', activePlan, { scope: 'private', refType: 'Plan', schema: PlanSchema });
        refs.push(selected);
        active = '## Active Plan\n\n' + formatRef(activePlan.title, selected);
    }
    const body = [
        '# Plan List',
        'Only one plan can be open at a time.',
        active,
        '## Unfinished Plans',
        ...(unfinishedPlans.length ? [unfinishedPlans.map((plan, index) => {
            const completed = plan.phases.filter(phase => phase.status === 'completed').length;
            return [
                '- **' + formatRef(plan.title, unfinished, index) + '**',
                `  Phases completed: ${completed}/${plan.phases.length}`,
                ...(plan.description ? ['  ' + plan.description] : []),
            ].join('\n');
        }).join('\n')] : ['No unfinished plans.']),
    ].join('\n\n');
    return { body, refs };
}
