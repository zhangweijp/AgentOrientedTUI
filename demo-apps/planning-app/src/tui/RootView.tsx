export function RootView() {
    return <section>
        <h1>Planning App - Application Instruction</h1>
        <h2>What it is</h2>
        <p>Organize work into Plans, Phases and Tasks, and track their progress.</p>
        <h2>How to use</h2>
        <ul>
            <li>PlanList shows unfinished plans and the active plan. Create or open a plan to work on its details; only one plan is open at a time.</li>
            <li>PlanDetail shows the active plan's phases and tasks. Manage those objects here, then close the plan to return to the list.</li>
            <li>For inline tasks, use objects such as <code>{'tasks: [{"title": "Review the design"}]'}</code>.</li>
            <li>Ref links label values and list elements. To select an element, use a full address such as $planning_app.plan_detail.completed_phases[0], using the App and View IDs from the page XML. Read the updated page before the next selection.</li>
            <li>The app checks that the object still exists and belongs to the active plan. Callable Tools and their parameter contracts are provided separately in the tool list.</li>
        </ul>
        <h2>Views</h2>
        <p>Planning pages have one instance per type. Call their tools with the declared business parameters. Use the published Ref from the page that owns the selected Plan, Phase or Task.</p>
    </section>;
}
