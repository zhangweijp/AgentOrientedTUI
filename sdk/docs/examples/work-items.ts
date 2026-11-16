import Type from 'typebox';
import { defineViewType, refParam, type JsonValue } from '@aotui/sdk/app';

const jsonList = Type.Array(Type.Unknown(), { maxItems: 8 });
export const itemValue = Type.Union([
    Type.String(), Type.Integer(), Type.Boolean(), Type.Null(), jsonList,
    Type.Object({ nested: jsonList }, { additionalProperties: false }),
]);
const operation = Type.Enum(['null', 'reset', 'reverse', 'empty', 'close', 'open', 'invalid', 'oversized', 'wait']);

type ItemContext = { change(update: (state: State) => State): void };

export const WorkspaceType = defineViewType<ItemContext & { options: WorkItemOptions }>()({
    name: 'Workspace',
    tools: {
        update: {
            description: 'Change which work items and values are shown.',
            inputSchema: Type.Object({
                operation,
                options: Type.Optional(Type.Object({
                    numbers: Type.Array(Type.Union([Type.Integer({ minimum: 0, maximum: 5 }), Type.Null()]), { maxItems: 2 }),
                    mode: Type.Literal('keep'),
                    'x-aotui-ref-kind': Type.Optional(Type.String({ pattern: '^[a-z]+$' })),
                }, { additionalProperties: false })),
            }, { additionalProperties: false }),
            async execute({ input: { operation }, context: { change, options } }) {
                if (operation === 'wait') await options.prepare?.();
                change(state => {
                    switch (operation) {
                        case 'null': return { ...state, value: null };
                        case 'reset': return { ...state, value: 0, items: initialItems };
                        case 'reverse': return { ...state, items: [...state.items].reverse().slice(0, 3) };
                        case 'empty': return { ...state, items: [] };
                        case 'close': return { ...state, open: false };
                        case 'open': return { ...state, open: true };
                        case 'invalid': return { ...state, value: { invalid: true } };
                        case 'oversized': return { ...state, oversized: true };
                        case 'wait': return { ...state, value: 2, note: 'Prepared' };
                    }
                });
                if (operation === 'invalid' || operation === 'oversized') {
                    void options.recover?.(operation).then(() => change(state => operation === 'invalid'
                        ? { ...state, value: 0 } : { ...state, oversized: undefined }));
                }
                return { success: true };
            },
        },
    },
});

export const ItemType = defineViewType<ItemContext>()({
    name: 'Item',
    tools: {
        inspect: {
            description: 'Record a selection in the Workspace View.',
            inputSchema: Type.Object({
                selected: refParam('Data', itemValue),
                elements: Type.Optional(Type.Array(refParam('Data', itemValue), { maxItems: 3 })),
                text: Type.Optional(Type.String({ default: 'example' })),
                'x-aotui-ref-value': Type.Optional(Type.Object({
                    'x-aotui-parameter-contract': Type.Literal('business'),
                }, { default: { 'x-aotui-parameter-contract': 'business' }, additionalProperties: false })),
            }, { additionalProperties: false }),
            execute({ input, context: { change } }) {
                change(state => ({ ...state, inspections: state.inspections + 1,
                    note: JSON.stringify({ selected: input.selected, elements: input.elements, text: input.text,
                        readonly: Object.isFrozen(input) && (input.elements === undefined || Object.isFrozen(input.elements)) }) }));
                return { success: true };
            },
        },
        count: {
            description: 'Confirm the selected value is a non-negative integer.',
            inputSchema: Type.Object({ selected: refParam('Data', Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
            execute() { return { success: true }; },
        },
    },
});

export const workViewTypes = [WorkspaceType, ItemType] as const;

export const label = 'Selected [work] \\ item';
export const selectedViewId = 'billing_export_2026_11';
export const otherViewId = 'b';
const initialItems = [0, false, '', null, { nested: [1, [false]] }] as const;

export interface State {
    readonly open: boolean;
    readonly value: JsonValue;
    readonly items: readonly JsonValue[];
    readonly inspections: number;
    readonly note: string;
    readonly oversized?: true | undefined;
}

export function initialState(): State {
    return { open: true, value: null, items: initialItems, inspections: 0, note: 'Ready' };
}

export interface WorkItemOptions {
    prepare?(): Promise<void>;
    recover?(fault: 'invalid' | 'oversized'): Promise<void>;
    onPublicationError?(error: unknown): void;
    onStop?(): void;
    onClose?(): void | Promise<void>;
}

export function workspaceText(state: State): string {
    if (state.oversized) return 'x'.repeat(513 * 1024);
    return `Inspections: ${state.inspections}\n${state.note}`;
}
