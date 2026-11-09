import { describe, expect, it, vi } from 'vitest';
import { createPlanDetailBindings, createPlanListBindings } from '../src/tui/planning-tools.js';
import type { Plan } from '../src/types.js';

const plan = (id: string, phaseId: string, taskId: string): Plan => ({
    id,
    title: `Plan ${id}`,
    phases: [{
        id: phaseId,
        title: `Phase ${phaseId}`,
        status: 'pending',
        tasks: [{ id: taskId, title: `Task ${taskId}`, status: 'pending' }],
        todos: [],
    }],
});

describe('planning app type-level tool handlers', () => {
    it('rejects stale PlanDetail calls after the active plan changes', async () => {
        const activePlan = plan('plan-b', 'phase-b', 'task-b');
        const previousPlan = plan('plan-a', 'phase-a', 'task-a');
        const addPhase = vi.fn(async () => 'phase-new');
        const deletePhase = vi.fn(async () => true);
        const completeTask = vi.fn(async () => true);
        const tools = createPlanDetailBindings({
            activePlan,
            addPhase,
            deletePhase,
            completePhase: vi.fn(async () => true),
            addTask: vi.fn(async () => 'task-new'),
            updateTask: vi.fn(async () => true),
            deleteTask: vi.fn(async () => true),
            completeTask,
        });

        const stalePlan = await tools.addPhase.execute({ plan: previousPlan, title: 'Wrong plan' });
        const stalePhase = await tools.deletePhase.execute({ phase: previousPlan.phases[0]! });
        const staleTask = await tools.completeTask.execute({ task: previousPlan.phases[0]!.tasks[0]! });

        expect(addPhase).not.toHaveBeenCalled();
        expect(deletePhase).not.toHaveBeenCalled();
        expect(completeTask).not.toHaveBeenCalled();
        expect(stalePlan).toMatchObject({ success: false, error: { code: 'PLAN_NOT_ACTIVE' } });
        expect(stalePhase).toMatchObject({ success: false, error: { code: 'PHASE_NOT_FOUND' } });
        expect(staleTask).toMatchObject({ success: false, error: { code: 'TASK_NOT_FOUND' } });
    });

    it('accepts a resolved current Phase and rejects objects belonging to another Plan', async () => {
        const activePlan = plan('plan-b', 'phase-b', 'task-b');
        const otherPlan = plan('plan-a', 'phase-a', 'task-a');
        const addTask = vi.fn(async () => 'task-new');
        const deleteTask = vi.fn(async () => true);
        const tools = createPlanDetailBindings({
            activePlan,
            addPhase: vi.fn(async () => 'phase-new'),
            deletePhase: vi.fn(async () => true),
            completePhase: vi.fn(async () => true),
            addTask,
            updateTask: vi.fn(async () => true),
            deleteTask,
            completeTask: vi.fn(async () => true),
        });

        const wrongPhase = await tools.addTask.execute({ phase: otherPlan.phases[0]!, title: 'wrong' });
        const acceptedTask = await tools.addTask.execute({ phase: activePlan.phases[0]!, title: 'right' });
        const wrongTask = await tools.deleteTask.execute({ task: otherPlan.phases[0]!.tasks[0]! });

        expect(addTask).toHaveBeenCalledTimes(1);
        expect(addTask).toHaveBeenCalledWith('phase-b', 'right', undefined);
        expect(deleteTask).not.toHaveBeenCalled();
        expect(wrongPhase).toMatchObject({ success: false, error: { code: 'PHASE_NOT_FOUND' } });
        expect(acceptedTask).toMatchObject({ success: true });
        expect(wrongTask).toMatchObject({ success: false, error: { code: 'TASK_NOT_FOUND' } });
    });

    it('rejects a resolved deleted or hidden Plan without invoking the delete callback', async () => {
        const deletePlan = vi.fn(async () => true);
        const currentPlan = plan('current', 'phase', 'task');
        const hiddenCompletedPlan = plan('completed-plan', 'completed-phase', 'completed-task');
        hiddenCompletedPlan.phases[0]!.status = 'completed';
        const tools = createPlanListBindings({
            plans: [currentPlan, hiddenCompletedPlan],
            activePlan: null,
            createPlan: vi.fn(async () => 'new'),
            updatePlan: vi.fn(async () => true),
            deletePlan,
            openPlan: vi.fn(async () => true),
            closePlan: vi.fn(),
        });

        const stale = await tools.deletePlan.execute({ plan: plan('deleted-plan', 'gone-phase', 'gone-task') });
        const hidden = await tools.deletePlan.execute({ plan: hiddenCompletedPlan });
        const current = await tools.deletePlan.execute({ plan: currentPlan });

        expect(deletePlan).toHaveBeenCalledTimes(1);
        expect(deletePlan).toHaveBeenCalledWith('current');
        expect(stale).toMatchObject({ success: false, error: { code: 'PLAN_NOT_FOUND' } });
        expect(hidden).toMatchObject({ success: false, error: { code: 'PLAN_NOT_FOUND' } });
        expect(current).toMatchObject({ success: true });
    });

    it('rejects a resolved child object after the active Plan has been closed', async () => {
        const previousPlan = plan('previous', 'phase', 'task');
        const addTask = vi.fn(async () => 'new-task');
        const tools = createPlanDetailBindings({
            activePlan: null,
            addPhase: vi.fn(async () => 'new-phase'),
            deletePhase: vi.fn(async () => true),
            completePhase: vi.fn(async () => true),
            addTask,
            updateTask: vi.fn(async () => true),
            deleteTask: vi.fn(async () => true),
            completeTask: vi.fn(async () => true),
        });
        const result = await tools.addTask.execute({ phase: previousPlan.phases[0]!, title: 'Must not be added' });
        expect(addTask).not.toHaveBeenCalled();
        expect(result).toMatchObject({ success: false, error: { code: 'PLAN_NOT_ACTIVE' } });
    });

    it('rejects malformed inline phases before creating a plan', async () => {
        const createPlan = vi.fn(async () => 'new-plan');
        const tools = createPlanListBindings({
            plans: [],
            activePlan: null,
            createPlan,
            updatePlan: vi.fn(async () => true),
            deletePlan: vi.fn(async () => true),
            openPlan: vi.fn(async () => true),
            closePlan: vi.fn(),
        });

        const receipt = await tools.createPlan.execute({ title: 'New plan', phases: [{ title: 42 }] });

        expect(createPlan).not.toHaveBeenCalled();
        expect(receipt).toMatchObject({ success: false, error: { code: 'INVALID_PHASES' } });
    });
});
