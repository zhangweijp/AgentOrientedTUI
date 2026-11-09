import { ToolCatalog } from '@aotui/sdk';
import { planningTools } from './planning-tools.js';

export function RootView() {
    return <section>
        <h1>Planning App - Application Instruction</h1>
        <h2>What it is</h2>
        <p>Organize work into Plans, Phases and Tasks, and track their progress.</p>
        <h2>How to use</h2>
        <ul>
            <li>PlanList shows unfinished plans and the active plan. Create or open a plan to work on its details; only one plan is open at a time.</li>
            <li>PlanDetail shows the active plan's phases and tasks. Manage those objects here, then close the plan to return to the list.</li>
            <li>Ref links show type and local name, such as Phase:completed_phases[0]. For Tool input, combine the containing View id with the local name: plan_detail.completed_phases[0], without Phase:. Read the updated View before the next selection.</li>
            <li>The app checks that the object still exists and belongs to the active plan. Callable Tools and their parameter contracts are provided separately in the tool list.</li>
        </ul>
        <h2>Views</h2>
        <ToolCatalog definition={planningTools} />
    </section>;
}
