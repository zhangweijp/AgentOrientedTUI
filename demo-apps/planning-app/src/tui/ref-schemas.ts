import Type from 'typebox';

const Status = Type.Enum(['pending', 'completed'], { type: 'string' });

// These are application data contracts. Internal IDs stay in the resolved value;
// the model supplies the published Ref name rather than assembling these objects.
export const TaskSchema = Type.Object({
    id: Type.String(),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    status: Status,
});

export const PhaseSchema = Type.Object({
    id: Type.String(),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    status: Status,
    tasks: Type.Array(TaskSchema),
    todos: Type.Array(TaskSchema),
});

export const PlanSchema = Type.Object({
    id: Type.String(),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    phases: Type.Array(PhaseSchema),
});
