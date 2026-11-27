import pkg from '../../package.json' with { type: 'json' };
import { createApp, createView, type ViewHandle } from '@aotui/sdk';
import type { Plan, Phase, PhaseInput, TaskInput, TaskItem } from '../types.js';
import { rootBody } from './RootView.js';
import { planListContent } from './PlanListView.js';
import { planDetailContent } from './PlanDetailView.js';
import { planningService } from '../core/planning-service.js';
import { RootType, PlanListType, PlanDetailType, planningViewTypes } from './planning-tools.js';

export default createApp({
    ...pkg.aotui,
    viewTypes: planningViewTypes,
    async initialize({ desktopId, launchConfig, publish: commit, registerLifecycle, signal }) {
        const dbPath = typeof launchConfig?.planningDbPath === 'string' && launchConfig.planningDbPath || undefined;
        planningService.configure(dbPath);
        registerLifecycle({ close: () => planningService.close() });

        let plans: Plan[] = [];
        let activePlanId: string | null = null;
        let detail: ViewHandle<typeof PlanDetailType> | undefined;
        const activePlan = () => plans.find(plan => plan.id === activePlanId) ?? null;

        function publish(warning = 'Planning changes were saved. The new pages could not be prepared.'): { projectionWarning?: string } {
            const result = commit(() => frames(activePlanId, detail));
            if (!result.ok) return { projectionWarning: warning };
            return {};
        }

        function setPlans(update: (previous: Plan[]) => Plan[]): void {
            plans = update(plans);
            publish();
        }

        function showSelection(id: string): void {
            const next = detail ?? createView(PlanDetailType, { id: 'plan_detail' });
            const result = commit(() => frames(id, next), { mode: 'candidate' });
            if (!result.ok) throw Object.assign(new Error('The selected Plan Detail does not fit. Shorten the plan before opening it.'), { code: result.issue.code });
            detail = next;
            activePlanId = id;
        }

        async function selectPlan(id: string | null): Promise<void> {
            if (id === null) {
                await planningService.setActivePlanId(desktopId, null);
                detail = undefined;
                activePlanId = null;
                publish();
                return;
            }
            showSelection(id);
            await planningService.setActivePlanId(desktopId, id);
        }

        const createPlan = async (title: string, description?: string, phases: PhaseInput[] = []) => {
            const plan = await planningService.createPlan(desktopId, title, description ?? '', phases);
            plans = [...plans, plan];
            try {
                await selectPlan(plan.id);
                return { planId: plan.id, selectionSaved: true };
            } catch (error) {
                publish();
                return {
                    planId: plan.id,
                    selectionSaved: false,
                    selectionError: error instanceof Error ? error.message : String(error),
                };
            }
        };

        const updatePlan = async (planId: string, updates: { title?: string; description?: string }) => {
            const updated = await planningService.updatePlan(desktopId, planId, updates);
            if (!updated) {
                return false;
            }
            setPlans((prev: Plan[]) =>
                prev.map((plan: Plan) => {
                    if (plan.id !== planId) {
                        return plan;
                    }
                    return {
                        ...plan,
                        title: updates.title ?? plan.title,
                        description: updates.description ?? plan.description
                    };
                })
            );
            return true;
        };

        const deletePlan = async (planId: string) => {
            const removed = await planningService.deletePlan(desktopId, planId);
            if (!removed) {
                return { deleted: false, selectionCleared: false };
            }
            plans = plans.filter(plan => plan.id !== planId);
            if (activePlanId === planId) {
                try {
                    await selectPlan(null);
                } catch (error) {
                    detail = undefined;
                    activePlanId = null;
                    publish();
                    return {
                        deleted: true,
                        selectionCleared: false,
                        selectionError: error instanceof Error ? error.message : String(error),
                    };
                }
            } else publish();
            return { deleted: true, selectionCleared: true };
        };

        const openPlan = async (planId: string) => {
            const exists = plans.some(plan => plan.id === planId);
            if (exists) {
                await selectPlan(planId);
            }
            return exists;
        };

        const closePlan = () => selectPlan(null);

        const addPhase = async (title: string, description?: string, tasks: TaskInput[] = []) => {
            const planId = activePlanId;
            if (!planId) {
                return null;
            }
            const phase = await planningService.addPhase(desktopId, planId, title, description ?? '', tasks);
            if (!phase) {
                return null;
            }
            setPlans((prev: Plan[]) =>
                prev.map((plan: Plan) => {
                    if (plan.id !== planId) {
                        return plan;
                    }
                    return {
                        ...plan,
                        phases: [...plan.phases, phase]
                    };
                })
            );
            return phase.id;
        };

        const findPhaseLocation = (phaseId: string): { planId: string; phaseId: string } | null => {
            for (const plan of plans) {
                const phase = plan.phases.find(item => item.id === phaseId);
                if (phase) {
                    return { planId: plan.id, phaseId: phase.id };
                }
            }
            return null;
        };

        const deletePhase = async (phaseId: string) => {
            const location = findPhaseLocation(phaseId);
            if (!location) {
                return false;
            }
            const { planId } = location;
            const deleted = await planningService.deletePhase(desktopId, phaseId);
            if (!deleted) {
                return false;
            }
            setPlans((prev: Plan[]) =>
                prev.map((plan: Plan) => {
                    if (plan.id !== planId) {
                        return plan;
                    }
                    const nextPhases = plan.phases.filter((phase: Phase) => phase.id !== phaseId);
                    return { ...plan, phases: nextPhases };
                })
            );
            return true;
        };

        const refreshCompletedPlans = async () => {
            try {
                plans = await planningService.getPlans(desktopId);
                return publish('The completion was saved. The Planning pages could not be refreshed.');
            } catch (error) {
                console.warn('Unable to refresh Planning pages after saving a completion', error);
                return { projectionWarning: 'The completion was saved. The Planning pages could not be refreshed.' };
            }
        };

        const completePhase = async (phaseId: string) => {
            if (!activePlanId) return null;
            const completed = await planningService.completePhase(desktopId, activePlanId, phaseId);
            if (!completed || (!completed.phaseChanged && completed.tasksCompleted === 0)) return completed;
            return { ...completed, ...await refreshCompletedPlans() };
        };

        const addTask = async (phaseId: string, title: string, description?: string) => {
            const location = findPhaseLocation(phaseId);
            if (!location) {
                return null;
            }
            const { planId } = location;
            const task = await planningService.addTask(desktopId, phaseId, title, description ?? '');
            if (!task) {
                return null;
            }
            setPlans((prev: Plan[]) =>
                prev.map((plan: Plan) => {
                    if (plan.id !== planId) {
                        return plan;
                    }
                    const nextPhases = plan.phases.map((phase: Phase) => {
                        if (phase.id !== phaseId) {
                            return phase;
                        }
                        return { ...phase, tasks: [...phase.tasks, task] };
                    });
                    return { ...plan, phases: nextPhases };
                })
            );
            return task.id;
        };

        const findTaskLocation = (taskId: string): { planId: string; phaseId: string } | null => {
            for (const plan of plans) {
                for (const phase of plan.phases) {
                    if (phase.tasks.some(task => task.id === taskId)) {
                        return { planId: plan.id, phaseId: phase.id };
                    }
                }
            }
            return null;
        };

        const updateTask = async (
            taskId: string,
            updates: { title?: string; description?: string }
        ) => {
            const location = findTaskLocation(taskId);
            if (!location) {
                return false;
            }
            const { planId, phaseId } = location;
            const updated = await planningService.updateTask(desktopId, taskId, updates);
            if (!updated) {
                return false;
            }
            setPlans((prev: Plan[]) =>
                prev.map((plan: Plan) => {
                    if (plan.id !== planId) {
                        return plan;
                    }
                    const nextPhases = plan.phases.map((phase: Phase) => {
                        if (phase.id !== phaseId) {
                            return phase;
                        }
                        const nextTasks = phase.tasks.map((task: TaskItem) => {
                            if (task.id !== taskId) {
                                return task;
                            }
                            return {
                                ...task,
                                title: updates.title ?? task.title,
                                description: updates.description ?? task.description
                            };
                        });
                        return { ...phase, tasks: nextTasks };
                    });
                    return { ...plan, phases: nextPhases };
                })
            );
            return true;
        };

        const deleteTask = async (taskId: string) => {
            const location = findTaskLocation(taskId);
            if (!location) {
                return false;
            }
            const { planId, phaseId } = location;
            const deleted = await planningService.deleteTask(desktopId, taskId);
            if (!deleted) {
                return false;
            }
            setPlans((prev: Plan[]) =>
                prev.map((plan: Plan) => {
                    if (plan.id !== planId) {
                        return plan;
                    }
                    const nextPhases = plan.phases.map((phase: Phase) => {
                        if (phase.id !== phaseId) {
                            return phase;
                        }
                        const nextTasks = phase.tasks.filter((task: TaskItem) => task.id !== taskId);
                        return { ...phase, tasks: nextTasks };
                    });
                    return { ...plan, phases: nextPhases };
                })
            );
            return true;
        };

        const completeTask = async (taskId: string) => {
            const location = findTaskLocation(taskId);
            if (!location || location.planId !== activePlanId) return null;
            if (!await planningService.completeTask(desktopId, taskId)) return null;
            return refreshCompletedPlans();
        };

        const root = createView(RootType, { id: 'root' });
        const list = createView(PlanListType, { id: 'plan_list' });
        function frames(id: string | null, selected?: ViewHandle<typeof PlanDetailType>) {
            const plan = plans.find(plan => plan.id === id) ?? null;
            return [root.frame({ name: 'Root', body: rootBody }), list.frame({
                ...planListContent(plans, plan),
                name: plan ? 'Plan List (Active Plan Open)' : 'Plan List',
                context: { plans, activePlan: plan, createPlan, updatePlan, deletePlan, openPlan, closePlan },
            }), ...(selected && plan ? [selected.frame({
                ...planDetailContent(plan), name: 'Plan: ' + plan.title, bindingKey: plan.id,
                context: { activePlan: plan, addPhase, deletePhase, completePhase, addTask, updateTask, deleteTask, completeTask },
            })] : [])];
        }

        publish();
        try {
            await planningService.init(dbPath);
            const [loaded, previous] = await Promise.all([
                planningService.getPlans(desktopId),
                planningService.getActivePlanId(desktopId),
            ]);
            if (signal.aborted) return;
            plans = loaded;
            publish();
            if (previous && plans.some(plan => plan.id === previous)) showSelection(previous);
        } catch (error) {
            console.warn('Unable to restore the Planning session from SQLite', error);
        }
    },
});
