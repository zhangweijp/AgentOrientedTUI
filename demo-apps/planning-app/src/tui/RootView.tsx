export function RootView() {
    return (
        <div data-role="application-instruction">
            <section>
                <h1>Planning App - Application Instruction</h1>
                <h2>What it is</h2>
                <p>Planning App organizes work into Plans, Phases, and Tasks with progress tracking.</p>

                <h2>How to use</h2>
                <ul>
                    <li>Start in PlanList to create, update, open, close, or delete plans.</li>
                    <li>Open a plan before using the PlanDetail tools for phases and tasks.</li>
                    <li>Pass the exact reference id currently shown in PlanList or PlanDetail.</li>
                    <li>The app resolves references against the current View data; stale or hidden ids are rejected.</li>
                </ul>

                <h2>Views</h2>
                <h3>PlanList</h3>
                <p><strong>What it shows:</strong> The full list of plans and the currently active plan, if one is open.</p>
                <p><strong>How to use:</strong> Use PlanList to create plans, open one for detailed work, or close/delete existing plans.</p>
                <h4>Tool Preconditions</h4>
                <ul>
                    <li><strong>create_plan</strong>: requires a title; optional phases and tasks can be supplied inline.</li>
                    <li><strong>update_plan</strong> / <strong>delete_plan</strong>: require a currently shown Plan reference or an active plan.</li>
                    <li><strong>open_plan</strong>: requires a currently shown Plan reference.</li>
                    <li><strong>close_plan</strong>: requires an active plan.</li>
                </ul>

                <h3>PlanDetail</h3>
                <p><strong>What it shows:</strong> The phases and tasks for the currently active plan, including completion progress.</p>
                <p><strong>How to use:</strong> Use PlanDetail after opening a plan to add, update, complete, or delete phases and tasks by reference.</p>
                <h4>Tool Preconditions</h4>
                <ul>
                    <li><strong>add_phase</strong>: requires an active plan.</li>
                    <li><strong>delete_phase</strong> / <strong>complete_phase</strong>: require a Phase reference shown in this PlanDetail.</li>
                    <li><strong>add_task</strong>: requires a Phase reference shown in this PlanDetail.</li>
                    <li><strong>update_task</strong> / <strong>delete_task</strong> / <strong>complete_task</strong>: require a Task reference shown in this PlanDetail.</li>
                </ul>
            </section>
        </div>
    );
}
