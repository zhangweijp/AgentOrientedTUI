import type { Plan, Phase, PhaseCompletion, PhaseInput, TaskInput, TaskItem } from '../types.js';
import * as db from '../db/index.js';

let configuredDbPath: string | undefined;

async function ensureDb(dbPath?: string) {
    if (dbPath !== undefined) {
        configuredDbPath = dbPath;
    }
    await db.initDatabase(configuredDbPath);
}

export const planningService = {
    configure(dbPath?: string): void {
        configuredDbPath = dbPath;
    },

    async init(dbPath?: string): Promise<void> {
        configuredDbPath = dbPath;
        await ensureDb(dbPath);
    },

    async getPlans(desktopId: string): Promise<Plan[]> {
        await ensureDb();
        return db.getPlans(desktopId);
    },

    async getActivePlanId(desktopId: string): Promise<string | null> {
        await ensureDb();
        return db.getActivePlanId(desktopId);
    },

    async setActivePlanId(desktopId: string, planId: string | null): Promise<void> {
        await ensureDb();
        await db.setActivePlanId(desktopId, planId);
    },

    async createPlan(
        desktopId: string,
        title: string,
        description: string = '',
        phases: PhaseInput[] = []
    ): Promise<Plan> {
        await ensureDb();
        const plan = await db.createPlan(desktopId, title, description);
        if (phases.length === 0) {
            return plan;
        }
        const createdPhases: Phase[] = [];
        for (const phaseInput of phases) {
            const phase = await db.createPhase(desktopId, plan.id, phaseInput.title, phaseInput.description ?? '');
            if (!phase) {
                continue;
            }
            const createdTasks: TaskItem[] = [];
            for (const taskInput of phaseInput.tasks ?? []) {
                const task = await db.createTodo(desktopId, phase.id, taskInput.title, taskInput.description ?? '');
                if (task) {
                    createdTasks.push(task);
                }
            }
            createdPhases.push({ ...phase, tasks: createdTasks });
        }
        return { ...plan, phases: createdPhases };
    },

    async updatePlan(desktopId: string, planId: string, updates: { title?: string; description?: string }): Promise<boolean> {
        await ensureDb();
        return db.updatePlan(desktopId, planId, updates);
    },

    async deletePlan(desktopId: string, planId: string): Promise<boolean> {
        await ensureDb();
        return db.deletePlan(desktopId, planId);
    },

    async addPhase(
        desktopId: string,
        planId: string,
        title: string,
        description: string = '',
        tasks: TaskInput[] = []
    ): Promise<Phase | null> {
        await ensureDb();
        const phase = await db.createPhase(desktopId, planId, title, description);
        if (!phase) {
            return null;
        }
        const createdTasks: TaskItem[] = [];
        for (const taskInput of tasks) {
            const task = await db.createTodo(desktopId, phase.id, taskInput.title, taskInput.description ?? '');
            if (task) {
                createdTasks.push(task);
            }
        }
        return { ...phase, tasks: createdTasks };
    },

    async deletePhase(desktopId: string, phaseId: string): Promise<boolean> {
        await ensureDb();
        return db.deletePhase(desktopId, phaseId);
    },

    async completePhase(desktopId: string, planId: string, phaseId: string): Promise<PhaseCompletion | null> {
        await ensureDb();
        return db.completePhase(desktopId, planId, phaseId);
    },

    async addTask(
        desktopId: string,
        phaseId: string,
        title: string,
        description: string = ''
    ): Promise<TaskItem | null> {
        await ensureDb();
        return db.createTodo(desktopId, phaseId, title, description);
    },

    async updateTask(
        desktopId: string,
        taskId: string,
        updates: { title?: string; description?: string }
    ): Promise<boolean> {
        await ensureDb();
        return db.updateTodo(desktopId, taskId, updates);
    },

    async deleteTask(desktopId: string, taskId: string): Promise<boolean> {
        await ensureDb();
        return db.deleteTodo(desktopId, taskId);
    },

    async completeTask(desktopId: string, taskId: string): Promise<boolean> {
        await ensureDb();
        return db.completeTodo(desktopId, taskId);
    },

    close(): void {
        db.closeDatabase();
    }
};
