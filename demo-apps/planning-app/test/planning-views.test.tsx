import { describe, expect, it, vi } from 'vitest';
import { PlanDetailView } from '../src/tui/PlanDetailView.js';
import { PlanListView } from '../src/tui/PlanListView.js';
import type { Plan } from '../src/types.js';

vi.mock('@aotui/sdk', () => ({
    useDataRef: (id: string, _data: unknown, options?: { refType: string }) =>
        (content: string) => `[${content}](${options?.refType ? options.refType + ':' : ''}${id})`,
    useArrayRef: (id: string, _data: unknown, options?: { itemType: string }) => [
        (content: string) => `[${content}](${options?.itemType ? options.itemType + '[]:' : ''}${id})`,
        (index: number, content: string) => `[${content}](${options?.itemType ? options.itemType + ':' : ''}${id}[${index}])`,
    ],
}));

const visibleText = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(visibleText).join(' ');
    if (typeof node === 'object' && 'props' in node) {
        if ('type' in node && typeof node.type === 'function') {
            return visibleText(node.type(node.props));
        }
        return visibleText((node as { props: { children?: unknown } }).props.children);
    }
    return '';
};

const currentPlan: Plan = {
    id: 'plan-current-7',
    title: 'Current plan',
    phases: [{
        id: 'phase-current-4',
        title: 'Current phase',
        status: 'pending',
        tasks: [{ id: 'task-current-2', title: 'Current task', status: 'pending' }],
        todos: [],
    }],
};

describe('Planning View object selection', () => {
    it('shows complete Plan Refs and descriptions without internal IDs', () => {
        const view = PlanListView({ plans: [currentPlan], activePlan: currentPlan });
        const text = visibleText(view).replace(/\s+/g, ' ').trim();

        expect(text).toContain('[Current plan](Plan:active_plan)');
        expect(text).toContain('[Current plan](Plan:unfinished_plans[0])');
        expect(text).not.toContain(currentPlan.id);
    });

    it('shows complete Plan, Phase and Task Refs without requiring business IDs', () => {
        const view = PlanDetailView({ plan: currentPlan });
        const text = visibleText(view).replace(/\s+/g, ' ').trim();

        expect(text).toContain('[Current plan](Plan:plan_detail_current)');
        expect(text).toContain('[Current phase](Phase:current_phase)');
        expect(text).toContain('[Current task](Task:pending_tasks[0])');
        expect(text).not.toContain(currentPlan.id);
        expect(text).not.toContain(currentPlan.phases[0]!.id);
        expect(text).not.toContain(currentPlan.phases[0]!.tasks[0]!.id);
    });

    it('does not display placeholder object references when no object exists', () => {
        const list = visibleText(PlanListView({ plans: [], activePlan: null }));
        const detail = visibleText(PlanDetailView({ plan: { ...currentPlan, phases: [] } }));
        expect(list).toContain('No active plan.');
        expect(list).not.toContain('Plan:active_plan');
        expect(detail).toContain('No active phase.');
        expect(detail).not.toContain('Phase:current_phase');
    });
});
