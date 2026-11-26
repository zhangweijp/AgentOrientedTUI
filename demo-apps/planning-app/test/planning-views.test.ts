import { describe, expect, it } from 'vitest';
import { planDetailContent } from '../src/tui/PlanDetailView.js';
import { planListContent } from '../src/tui/PlanListView.js';
import type { Plan } from '../src/types.js';

const currentPlan: Plan = {
    id: 'plan-current-7',
    title: 'Current plan',
    phases: [{
        id: 'phase-current-4',
        title: 'Current phase',
        status: 'pending',
        tasks: [{ id: 'task-current-2', title: 'Current task', status: 'pending' }],
    }],
};

describe('Planning View object selection', () => {
    it('shows complete Plan Refs and descriptions without internal IDs', () => {
        const { body: text, refs } = planListContent([currentPlan], currentPlan);
        expect(refs.map(item => item.id)).toEqual(['unfinished_plans', 'active_plan']);

        expect(text).toContain('[Current plan](private active_plan: Plan)');
        expect(text).toContain('[Current plan](unfinished_plans[0])');
        expect(text).not.toContain(currentPlan.id);
    });

    it('shows complete Plan, Phase and Task Refs without requiring business IDs', () => {
        const { body: text, refs } = planDetailContent(currentPlan);
        expect(refs.map(item => item.id)).toContain('pending_tasks');

        expect(text).toContain('[Current plan](private plan_detail_current: Plan)');
        expect(text).toContain('[Current phase](private current_phase: Phase)');
        expect(text).toContain('[Current task](pending_tasks[0])');
        expect(text).not.toContain(currentPlan.id);
        expect(text).not.toContain(currentPlan.phases[0]!.id);
        expect(text).not.toContain(currentPlan.phases[0]!.tasks[0]!.id);
    });

    it('does not display placeholder object references when no object exists', () => {
        const list = planListContent([], null).body;
        const detail = planDetailContent({ ...currentPlan, phases: [] }).body;
        expect(list).toContain('No active plan.');
        expect(list).not.toContain('private active_plan: Plan');
        expect(detail).toContain('No active phase.');
        expect(detail).not.toContain('private current_phase: Phase');
    });
});
