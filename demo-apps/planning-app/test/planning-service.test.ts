import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { planningService } from '../src/core/planning-service.js';

const TEST_DESKTOP = 'planning_test_desktop_1';
const OTHER_DESKTOP = 'planning_test_desktop_2';

describe('planning service with sqlite', () => {
    beforeAll(async () => {
        await planningService.init();
        for (const desktop of [TEST_DESKTOP, OTHER_DESKTOP]) {
            for (const plan of await planningService.getPlans(desktop)) await planningService.deletePlan(desktop, plan.id);
        }
    });

    afterAll(() => {
        planningService.close();
    });

    it('creates plan, phase, and task', async () => {
        const plan = await planningService.createPlan(TEST_DESKTOP, 'Plan A', 'Desc A');
        const phase = await planningService.addPhase(TEST_DESKTOP, plan.id, 'Phase 1', 'P1');
        if (!phase) {
            throw new Error('phase not created');
        }
        const task = await planningService.addTask(TEST_DESKTOP, phase.id, 'Todo 1', 'T1');
        if (!task) {
            throw new Error('task not created');
        }

        const plans = await planningService.getPlans(TEST_DESKTOP);
        expect(plans.length).toBe(1);
        expect(plans[0].phases.length).toBe(1);
        expect(plans[0].phases[0].tasks.length).toBe(1);
    });

    it('creates plan with phases and tasks in one call', async () => {
        const plan = await planningService.createPlan(TEST_DESKTOP, 'Plan Bulk', 'Desc Bulk', [
            {
                title: 'Phase A',
                description: 'Phase A Desc',
                tasks: [
                    { title: 'Todo A1', description: 'Todo A1 Desc' },
                    { title: 'Todo A2' }
                ]
            },
            {
                title: 'Phase B',
                tasks: [{ title: 'Todo B1' }]
            }
        ]);

        const plans = await planningService.getPlans(TEST_DESKTOP);
        const created = plans.find(item => item.id === plan.id);
        expect(created?.phases.length).toBe(2);
        expect(created?.phases[0].tasks.length).toBe(2);
        expect(created?.phases[1].tasks.length).toBe(1);
    });

    it('adds phase with tasks in one call', async () => {
        const plan = await planningService.createPlan(TEST_DESKTOP, 'Plan Phase Bulk', 'Desc');
        const phase = await planningService.addPhase(TEST_DESKTOP, plan.id, 'Phase Bulk', 'Phase Desc', [
            { title: 'Todo 1', description: 'Todo 1 Desc' },
            { title: 'Todo 2' }
        ]);
        expect(phase?.tasks.length).toBe(2);
        const plans = await planningService.getPlans(TEST_DESKTOP);
        const created = plans.find(item => item.id === plan.id);
        expect(created?.phases.length).toBe(1);
        expect(created?.phases[0].tasks.length).toBe(2);
    });

    it('isolates data by desktop', async () => {
        await planningService.createPlan(OTHER_DESKTOP, 'Other Plan');
        const plans = await planningService.getPlans(TEST_DESKTOP);
        const otherPlans = await planningService.getPlans(OTHER_DESKTOP);
        expect(plans.every(plan => plan.title !== 'Other Plan')).toBe(true);
        expect(otherPlans.some(plan => plan.title === 'Other Plan')).toBe(true);
    });

    it('completes task and phase', async () => {
        // Reopen the SQLite file to exercise records in the existing todos table.
        planningService.close();
        const plans = await planningService.getPlans(TEST_DESKTOP);
        const plan = plans.find(item => item.title === 'Plan A') ?? plans[0];
        const phase = plan.phases[0];
        expect(phase).not.toHaveProperty('todos');
        const task = phase.tasks[0];
        const taskCompleted = await planningService.completeTask(TEST_DESKTOP, task.id);
        expect(taskCompleted).toBe(true);
        const phaseCompleted = await planningService.completePhase(TEST_DESKTOP, plan.id, phase.id);
        expect(phaseCompleted).toEqual({ title: phase.title, phaseChanged: true, tasksCompleted: 0 });

        const updated = await planningService.getPlans(TEST_DESKTOP);
        const updatedPhase = updated[0].phases[0];
        expect(updatedPhase.status).toBe('completed');
        expect(updatedPhase.tasks.every(item => item.status === 'completed')).toBe(true);
    });

    it('refuses to complete a phase that is missing or outside the selected plan and desktop', async () => {
        const plan = await planningService.createPlan(TEST_DESKTOP, 'Completion ownership', '', [
            { title: 'Owned phase', tasks: [{ title: 'Owned task' }] },
        ]);
        const phase = plan.phases[0]!;
        const other = await planningService.createPlan(TEST_DESKTOP, 'Another plan');
        expect(await planningService.completePhase(TEST_DESKTOP, other.id, phase.id)).toBeNull();
        expect(await planningService.completePhase(OTHER_DESKTOP, plan.id, phase.id)).toBeNull();
        const stored = (await planningService.getPlans(TEST_DESKTOP)).find(item => item.id === plan.id);
        expect(stored?.phases[0]).toMatchObject({ status: 'pending', tasks: [{ status: 'pending' }] });
        expect(await planningService.deletePhase(TEST_DESKTOP, phase.id)).toBe(true);
        expect(await planningService.completePhase(TEST_DESKTOP, plan.id, phase.id)).toBeNull();
    });

    it('deletes plan with phases and tasks', async () => {
        const plans = await planningService.getPlans(TEST_DESKTOP);
        for (const plan of plans) {
            const deleted = await planningService.deletePlan(TEST_DESKTOP, plan.id);
            expect(deleted).toBe(true);
        }
        const updated = await planningService.getPlans(TEST_DESKTOP);
        expect(updated.length).toBe(0);
    });
});
