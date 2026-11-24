import pkg from '../../package.json' with { type: 'json' };
import { createTUIApp, useEffect, useMemo, useRef, useState, useAppLifecycle, useAppRuntimeContext } from '@aotui/sdk';
import type { Plan, Phase, PhaseInput, TaskInput, TaskItem } from '../types.js';
import { RootView } from './RootView.js';
import { PlanListView } from './PlanListView.js';
import { PlanDetailView } from './PlanDetailView.js';
import { planningService } from '../core/planning-service.js';
import { RootType, PlanListType, PlanDetailType, planningViewTypes } from './planning-tools.js';

function PlanningApp() {
    const [plans, setPlans] = useState<Plan[]>([]);
    const [activePlanId, setActivePlanId] = useState<string | null>(null);
    const selectedInSession = useRef(false);
    const { desktopId, persistence, prepareProjection } = useAppRuntimeContext();
    useAppLifecycle({ close: () => planningService.close() });

    const activePlan = useMemo(
        () => plans.find(plan => plan.id === activePlanId) || null,
        [plans, activePlanId]
    );

    useEffect(() => {
        let cancelled = false;
        const loadPlans = async () => {
            await planningService.init();
            const loadedPlans = await planningService.getPlans(desktopId);
            if (cancelled) {
                return;
            }
            setPlans(loadedPlans);
            try {
                const previous = await persistence?.load('activePlanId');
                if (!cancelled && !selectedInSession.current && typeof previous === 'string' &&
                    loadedPlans.some(plan => plan.id === previous)) setActivePlanId(previous);
            } catch (error) { console.warn('Unable to load the active plan selection', error); }
        };
        void loadPlans();
        return () => {
            cancelled = true;
        };
    }, [desktopId, persistence]);

    const selectPlan = async (id: string | null) => {
        selectedInSession.current = true;
        setActivePlanId(id);
        try { await persistence?.save('activePlanId', id); }
        catch (error) { console.warn('Unable to save the active plan selection', error); }
    };

    const createPlan = async (title: string, description?: string, phases: PhaseInput[] = []) => {
        const plan = await planningService.createPlan(desktopId, title, description ?? '', phases);
        setPlans((prev: Plan[]) => [...prev, plan]);
        await selectPlan(plan.id);
        return plan.id;
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
            return false;
        }
        setPlans((prev: Plan[]) => prev.filter((plan: Plan) => plan.id !== planId));
        if (activePlanId === planId) {
            await selectPlan(null);
        }
        return true;
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
            const updated = await planningService.getPlans(desktopId);
            await prepareProjection(() => setPlans(updated));
            return {};
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

    const updateTask = (
        taskId: string,
        updates: { title?: string; description?: string }
    ) => {
        const run = async () => {
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
        return run();
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

    const planListContext = {
        plans,
        activePlan,
        createPlan,
        updatePlan,
        deletePlan,
        openPlan,
        closePlan,
    };

    const planDetailContext = {
        activePlan,
        addPhase,
        deletePhase,
        completePhase,
        addTask,
        updateTask,
        deleteTask,
        completeTask,
    };

    const planListName = activePlan ? 'Plan List (Active Plan Open)' : 'Plan List';
    const planDetailName = activePlan ? `Plan: ${activePlan.title}` : 'Plan Detail';

    return (
        <>
            <RootType id="root" name="Root">
                <RootView />
            </RootType>

            <PlanListType id="plan_list" context={planListContext} name={planListName}>
                <PlanListView plans={plans} activePlan={activePlan} />
            </PlanListType>

            {activePlan ? (
                <PlanDetailType id="plan_detail" context={planDetailContext} name={planDetailName}>
                    <PlanDetailView plan={activePlan} />
                </PlanDetailType>
            ) : null}
        </>
    );
}

export default createTUIApp({
    ...pkg.aotui,
    component: PlanningApp,
    viewTypes: planningViewTypes,
});
