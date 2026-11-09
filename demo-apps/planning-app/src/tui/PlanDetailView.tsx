import { useArrayRef, useDataRef } from '@aotui/sdk';
import type { Phase, Plan, TaskItem } from '../types.js';

type PlanDetailViewProps = {
    plan: Plan;
};

const splitPhases = (phases: Phase[]) => {
    const completed: Phase[] = [];
    const pending: Phase[] = [];
    phases.forEach(phase => phase.status === 'completed' ? completed.push(phase) : pending.push(phase));
    return { completed, current: pending[0] || null, upcoming: pending.slice(1) };
};

const PhaseTaskList = ({ refKey, tasks }: { refKey: string; tasks: TaskItem[] }) => {
    const [, phaseTaskRef] = useArrayRef(refKey, tasks, { itemType: 'Task' });
    if (tasks.length === 0) return <p>No tasks.</p>;
    return <ul>{tasks.map((task, index) => <li key={task.id}>{phaseTaskRef(index, task.title)}</li>)}</ul>;
};

function CurrentPhase({ phase }: { phase: Phase }) {
    const phaseRef = useDataRef('current_phase', phase, { refType: 'Phase' });
    const pendingTasks = phase.tasks.filter(task => task.status === 'pending');
    const completedTasks = phase.tasks.filter(task => task.status === 'completed');
    return <div>
        <h4>{phaseRef(phase.title)}</h4>
        {phase.description ? <p>{phase.description}</p> : null}
        <h5>Pending Tasks</h5>
        <PhaseTaskList refKey="pending_tasks" tasks={pendingTasks} />
        <h5>Completed Tasks</h5>
        <PhaseTaskList refKey="completed_tasks" tasks={completedTasks} />
    </div>;
}

export function PlanDetailView({ plan }: PlanDetailViewProps) {
    const { completed, current, upcoming } = splitPhases(plan.phases);

    const planRef = useDataRef('plan_detail_current', plan, { refType: 'Plan' });
    const [, completedPhaseRef] = useArrayRef('completed_phases', completed, { itemType: 'Phase' });
    const [, upcomingPhaseRef] = useArrayRef('upcoming_phases', upcoming, { itemType: 'Phase' });

    return (
        <>
            <div>
                <h1>Plan Detail</h1>
                <h2>{planRef(plan.title)}</h2>
                {plan.description ? <p>{plan.description}</p> : null}

                <h3>Completed Phases</h3>
                {completed.length === 0 ? <p>No completed phases.</p> : (
                    <ul>{completed.map((phase, index) => <li key={phase.id}>
                        <div>{completedPhaseRef(index, phase.title)}</div>
                    </li>)}</ul>
                )}

                <h3>Current Phase</h3>
                {current ? <CurrentPhase phase={current} /> : <p>No active phase. Add a phase to start.</p>}

                <h3>Upcoming Phases</h3>
                {upcoming.length === 0 ? <p>No upcoming phases.</p> : (
                    <ul>{upcoming.map((phase, index) => <li key={phase.id}>
                        <div>{upcomingPhaseRef(index, phase.title)}</div>
                        <PhaseTaskList refKey={`upcoming_phase_${index}_tasks`} tasks={phase.tasks} />
                    </li>)}</ul>
                )}
            </div>
        </>
    );
}
