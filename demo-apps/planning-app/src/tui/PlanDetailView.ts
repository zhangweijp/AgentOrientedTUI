import Type from 'typebox';
import { arrayRef, formatRef, ref, type PublishedRef } from '@aotui/sdk';
import type { Plan, TaskItem } from '../types.js';
import { PhaseSchema, PlanSchema, TaskSchema } from './ref-schemas.js';

const PhaseList = Type.Array(PhaseSchema);
const TaskList = Type.Array(TaskSchema);

export function planDetailContent(plan: Plan): { body: string; refs: PublishedRef[] } {
    const completed = plan.phases.filter(phase => phase.status === 'completed');
    const [current, ...upcoming] = plan.phases.filter(phase => phase.status !== 'completed');
    const planRef = ref('plan_detail_current', plan, { scope: 'private', refType: 'Plan', schema: PlanSchema });
    const completedRef = arrayRef('completed_phases', completed, { scope: 'private', itemType: 'Phase', schema: PhaseList });
    const upcomingRef = arrayRef('upcoming_phases', upcoming, { scope: 'private', itemType: 'Phase', schema: PhaseList });
    const refs: PublishedRef[] = [planRef, completedRef, upcomingRef];
    function taskList(id: string, tasks: TaskItem[]): string {
        const items = arrayRef(id, tasks, { scope: 'private', itemType: 'Task', schema: TaskList });
        refs.push(items);
        return tasks.length ? tasks.map((task, index) => '- ' + formatRef(task.title, items, index)).join('\n') : 'No tasks.';
    }

    const currentBody: string[] = [];
    if (current) {
        const phaseRef = ref('current_phase', current, { scope: 'private', refType: 'Phase', schema: PhaseSchema });
        refs.push(phaseRef);
        currentBody.push(
            '#### ' + formatRef(current.title, phaseRef),
            ...(current.description ? [current.description] : []),
            '##### Pending Tasks',
            taskList('pending_tasks', current.tasks.filter(task => task.status === 'pending')),
            '##### Completed Tasks',
            taskList('completed_tasks', current.tasks.filter(task => task.status === 'completed')),
        );
    } else currentBody.push('No active phase. Add a phase to start.');

    const body = [
        '# Plan Detail',
        '## ' + formatRef(plan.title, planRef),
        ...(plan.description ? [plan.description] : []),
        '### Completed Phases',
        completed.length ? completed.map((phase, index) => '- ' + formatRef(phase.title, completedRef, index)).join('\n') : 'No completed phases.',
        '### Current Phase',
        ...currentBody,
        '### Upcoming Phases',
        ...(upcoming.length ? upcoming.flatMap((phase, index) => [
            '#### ' + formatRef(phase.title, upcomingRef, index),
            taskList(`upcoming_phase_${index}_tasks`, phase.tasks),
        ]) : ['No upcoming phases.']),
    ].join('\n\n');

    return { body, refs };
}
