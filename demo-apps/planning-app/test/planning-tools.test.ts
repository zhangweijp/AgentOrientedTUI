import { describe, expect, it, vi } from 'vitest';
import { captureViewBindings, captureViewTypes } from '../../../sdk/src/tools/view-type-tool.js';
import { PlanDetailType, PlanListType } from '../src/tui/planning-tools.js';
import type { Plan } from '../src/types.js';

const plan = (id: string, phaseId: string, taskId: string): Plan => ({
    id,
    title: `Plan ${id}`,
    phases: [{
        id: phaseId,
        title: `Phase ${phaseId}`,
        status: 'pending',
        tasks: [{ id: taskId, title: `Task ${taskId}`, status: 'pending' }],
    }],
});

const pageTools = (type: typeof PlanListType | typeof PlanDetailType, context: object) =>
    Object.fromEntries(captureViewBindings(captureViewTypes([type]).values().next().value!, 'plan', context).map(tool => [tool.name, tool]));

describe('planning app type-level tool handlers', () => {
    it('rejects stale PlanDetail calls after the active plan changes', async () => {
        const activePlan = plan('plan-b', 'phase-b', 'task-b');
        const previousPlan = plan('plan-a', 'phase-a', 'task-a');
        const addPhase = vi.fn(async () => 'phase-new');
        const deletePhase = vi.fn(async () => true);
        const completeTask = vi.fn(async () => null);
        const completePhase = vi.fn(async () => null);
        const tools = pageTools(PlanDetailType, {
            activePlan,
            addPhase,
            deletePhase,
            completePhase,
            addTask: vi.fn(async () => 'task-new'),
            updateTask: vi.fn(async () => true),
            deleteTask: vi.fn(async () => true),
            completeTask,
        });

        const stalePlan = await tools.add_phase.execute({ plan: previousPlan, title: 'Wrong plan' });
        const stalePhase = await tools.delete_phase.execute({ phase: previousPlan.phases[0]! });
        const staleCompletion = await tools.complete_phase.execute({ phase: previousPlan.phases[0]! });
        const staleTask = await tools.complete_task.execute({ task: previousPlan.phases[0]!.tasks[0]! });

        expect(addPhase).not.toHaveBeenCalled();
        expect(deletePhase).not.toHaveBeenCalled();
        expect(completePhase).not.toHaveBeenCalled();
        expect(completeTask).not.toHaveBeenCalled();
        expect(stalePlan).toMatchObject({ success: false, error: { code: 'PLAN_NOT_ACTIVE' } });
        expect(stalePhase).toMatchObject({ success: false, error: { code: 'PHASE_NOT_FOUND' } });
        expect(staleCompletion).toMatchObject({ success: false, error: { code: 'PHASE_NOT_FOUND' } });
        expect(staleTask).toMatchObject({ success: false, error: { code: 'TASK_NOT_FOUND' } });
    });

    it('accepts a resolved current Phase and rejects objects belonging to another Plan', async () => {
        const activePlan = plan('plan-b', 'phase-b', 'task-b');
        const otherPlan = plan('plan-a', 'phase-a', 'task-a');
        const addTask = vi.fn(async () => 'task-new');
        const deleteTask = vi.fn(async () => true);
        const tools = pageTools(PlanDetailType, {
            activePlan,
            addPhase: vi.fn(async () => 'phase-new'),
            deletePhase: vi.fn(async () => true),
            completePhase: vi.fn(async () => null),
            addTask,
            updateTask: vi.fn(async () => true),
            deleteTask,
            completeTask: vi.fn(async () => null),
        });

        const wrongPhase = await tools.add_task.execute({ phase: otherPlan.phases[0]!, title: 'wrong' });
        const acceptedTask = await tools.add_task.execute({ phase: activePlan.phases[0]!, title: 'right' });
        const wrongTask = await tools.delete_task.execute({ task: otherPlan.phases[0]!.tasks[0]! });

        expect(addTask).toHaveBeenCalledTimes(1);
        expect(addTask).toHaveBeenCalledWith('phase-b', 'right', undefined);
        expect(deleteTask).not.toHaveBeenCalled();
        expect(wrongPhase).toMatchObject({ success: false, error: { code: 'PHASE_NOT_FOUND' } });
        expect(acceptedTask).toMatchObject({ success: true });
        expect(wrongTask).toMatchObject({ success: false, error: { code: 'TASK_NOT_FOUND' } });
    });

    it('rejects a resolved deleted or hidden Plan without invoking the delete callback', async () => {
        const deletePlan = vi.fn(async () => ({ deleted: true, selectionCleared: true }));
        const currentPlan = plan('current', 'phase', 'task');
        const hiddenCompletedPlan = plan('completed-plan', 'completed-phase', 'completed-task');
        hiddenCompletedPlan.phases[0]!.status = 'completed';
        const tools = pageTools(PlanListType, {
            plans: [currentPlan, hiddenCompletedPlan],
            activePlan: null,
            createPlan: vi.fn(async () => ({ planId: 'new', selectionSaved: true })),
            updatePlan: vi.fn(async () => true),
            deletePlan,
            openPlan: vi.fn(async () => true),
            closePlan: vi.fn(),
        });

        const stale = await tools.delete_plan.execute({ plan: plan('deleted-plan', 'gone-phase', 'gone-task') });
        const hidden = await tools.delete_plan.execute({ plan: hiddenCompletedPlan });
        const current = await tools.delete_plan.execute({ plan: currentPlan });

        expect(deletePlan).toHaveBeenCalledTimes(1);
        expect(deletePlan).toHaveBeenCalledWith('current');
        expect(stale).toMatchObject({ success: false, error: { code: 'PLAN_NOT_FOUND' } });
        expect(hidden).toMatchObject({ success: false, error: { code: 'PLAN_NOT_FOUND' } });
        expect(current).toMatchObject({ success: true });
    });

    it('rejects a resolved child object after the active Plan has been closed', async () => {
        const previousPlan = plan('previous', 'phase', 'task');
        const addTask = vi.fn(async () => 'new-task');
        const tools = pageTools(PlanDetailType, {
            activePlan: null,
            addPhase: vi.fn(async () => 'new-phase'),
            deletePhase: vi.fn(async () => true),
            completePhase: vi.fn(async () => null),
            addTask,
            updateTask: vi.fn(async () => true),
            deleteTask: vi.fn(async () => true),
            completeTask: vi.fn(async () => null),
        });
        const result = await tools.add_task.execute({ phase: previousPlan.phases[0]!, title: 'Must not be added' });
        expect(addTask).not.toHaveBeenCalled();
        expect(result).toMatchObject({ success: false, error: { code: 'PLAN_NOT_ACTIVE' } });
    });

    it('keeps the successful completion receipt when the saved state could not be projected', async () => {
        const activePlan = plan('current', 'phase', 'task');
        const projectionWarning = 'The completion was saved. The Planning pages could not be refreshed.';
        const tools = pageTools(PlanDetailType, {
            activePlan,
            completePhase: async () => ({ title: 'Phase phase', phaseChanged: false, tasksCompleted: 1, projectionWarning }),
            completeTask: async () => ({ projectionWarning }),
        });
        expect(await tools.complete_phase.execute({ phase: activePlan.phases[0]! })).toEqual({ success: true, data: {
            message: 'Phase "Phase phase" was already complete. Completed 1 remaining task.', tasksCompleted: 1, projectionWarning,
        } });
        expect(await tools.complete_task.execute({ task: activePlan.phases[0]!.tasks[0]! })).toEqual({ success: true, data: {
            message: 'Task "Task task" completed.', projectionWarning,
        } });
    });

    it('creates a plan with optional initial tasks', async () => {
        const createPlan = vi.fn(async () => ({ planId: 'new-plan', selectionSaved: true }));
        const tools = pageTools(PlanListType, {
            plans: [],
            activePlan: null,
            createPlan,
            updatePlan: vi.fn(async () => true),
            deletePlan: vi.fn(async () => ({ deleted: true, selectionCleared: true })),
            openPlan: vi.fn(async () => true),
            closePlan: vi.fn(),
        });

        const receipt = await tools.create_plan.execute({ title: 'New plan', phases: [
            { title: 'Design' },
            { title: 'Review', tasks: [{ title: 'Accepted' }] },
        ] });

        expect(createPlan).toHaveBeenCalledWith('New plan', undefined, [
            { title: 'Design', tasks: [] },
            { title: 'Review', tasks: [{ title: 'Accepted' }] },
        ]);
        expect(receipt).toMatchObject({ success: true, data: { planId: 'new-plan', message: 'Plan created with 2 phases and 1 tasks.' } });
    });

    it('reports step-wise honest receipts when plan creation/deletion succeeds on disk but selection save/clear fails', async () => {
        const target = plan('target-plan', 'phase-1', 'task-1');
        const tools = pageTools(PlanListType, {
            plans: [target],
            activePlan: target,
            createPlan: async () => ({ planId: 'plan-created-1', selectionSaved: false, selectionError: 'Database busy' }),
            updatePlan: async () => true,
            deletePlan: async () => ({ deleted: true, selectionCleared: false, selectionError: 'Database busy' }),
            openPlan: async () => { throw new Error('Database busy during open'); },
            closePlan: async () => { throw new Error('Database busy during close'); },
        });

        const createReceipt = await tools.create_plan.execute({ title: 'New plan' });
        expect(createReceipt).toMatchObject({
            success: true,
            data: {
                planId: 'plan-created-1',
                planCreated: true,
                selectionSaved: false,
            },
        });
        expect((createReceipt as { data: { selectionWarning: string } }).data.selectionWarning).toContain('Do not re-create');

        const deleteReceipt = await tools.delete_plan.execute({ plan: target });
        expect(deleteReceipt).toMatchObject({
            success: true,
            data: {
                planId: 'target-plan',
                planDeleted: true,
                selectionCleared: false,
            },
        });
        expect((deleteReceipt as { data: { selectionWarning: string } }).data.selectionWarning).toContain('deleted from disk');

        const openReceipt = await tools.open_plan.execute({ plan: target });
        expect(openReceipt).toMatchObject({ success: false, error: { code: 'PLAN_SELECTION_SAVE_FAILED' } });

        const closeReceipt = await tools.close_plan.execute({});
        expect(closeReceipt).toMatchObject({ success: false, error: { code: 'PLAN_SELECTION_SAVE_FAILED' } });
    });

    it('surfaces PLANNING_DB_BUSY instead of throwing or overwriting error codes', async () => {
        const target = plan('target-plan', 'phase-1', 'task-1');
        const busyError = () => Object.assign(new Error('Planning database is currently in use'), { code: 'PLANNING_DB_BUSY' });
        const listTools = pageTools(PlanListType, {
            plans: [target],
            activePlan: target,
            createPlan: async () => { throw busyError(); },
            updatePlan: async () => { throw busyError(); },
            deletePlan: async () => { throw busyError(); },
            openPlan: async () => { throw busyError(); },
            closePlan: async () => { throw busyError(); },
        });
        const detailTools = pageTools(PlanDetailType, {
            activePlan: target,
            addPhase: async () => { throw busyError(); },
            deletePhase: async () => { throw busyError(); },
            completePhase: async () => { throw busyError(); },
            addTask: async () => { throw busyError(); },
            updateTask: async () => { throw busyError(); },
            deleteTask: async () => { throw busyError(); },
            completeTask: async () => { throw busyError(); },
        });

        expect(await listTools.create_plan.execute({ title: 'Blocked' })).toMatchObject({ success: false, error: { code: 'PLANNING_DB_BUSY' } });
        expect(await listTools.open_plan.execute({ plan: target })).toMatchObject({ success: false, error: { code: 'PLANNING_DB_BUSY' } });
        expect(await listTools.close_plan.execute({})).toMatchObject({ success: false, error: { code: 'PLANNING_DB_BUSY' } });
        expect(await detailTools.complete_phase.execute({ phase: target.phases[0]! })).toMatchObject({ success: false, error: { code: 'PLANNING_DB_BUSY' } });
        expect(await detailTools.complete_task.execute({ task: target.phases[0]!.tasks[0]! })).toMatchObject({ success: false, error: { code: 'PLANNING_DB_BUSY' } });
    });
});
