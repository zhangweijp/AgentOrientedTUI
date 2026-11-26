export const rootBody = `# Planning App - Application Instruction

## What it is

Organize work into Plans, Phases and Tasks, and track their progress.

## How to use

- PlanList shows unfinished plans and the active plan. Create or open a plan to work on its details. Only one plan is open at a time.
- PlanDetail shows the active plan's phases and tasks. Manage those objects here, then close the plan to return to the list.
- For inline tasks, use objects such as tasks: [{"title": "Review the design"}].
- A link such as [Design](completed_phases[0]) uses a local Ref name. In a Tool argument pass the complete address, for example $ref.planning_app.plan_detail.completed_phases[0]. Use the actual app_id and view_id from the page XML. Read the updated page before the next selection.
- The app checks that the object still exists and belongs to the active plan.

## Views

Planning pages have one instance per type. Call their tools with the declared business parameters. Use the published Ref from the page that owns the selected Plan, Phase or Task.
`;
