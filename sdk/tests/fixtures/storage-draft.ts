import Type from 'typebox';
import { defineViewType, type AppStatePersistence } from '@aotui/sdk/app';

const none = Type.Object({}, { additionalProperties: false });
const success = { success: true } as const;
type Draft = ReturnType<typeof createDraft>;
export const Sheet = defineViewType<Draft>()({ name: 'sheet', region: 'dynamic', multiplicity: 'single', tools: {
    edit: { description: 'Edit the in-memory draft', inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
        execute: ({ input, context }) => context.edit(input.text) },
    save: { description: 'Save the current draft', inputSchema: none, execute: ({ context }) => context.save() },
    load: { description: 'Read the saved draft and choose whether to use it',
        inputSchema: Type.Object({ adopt: Type.Boolean() }, { additionalProperties: false }),
        execute: ({ input, context }) => context.load(input.adopt) },
    remove: { description: 'Remove the saved draft', inputSchema: none, execute: ({ context }) => context.remove() },
    keep: { description: 'Save a separate record in this workspace', inputSchema: none, execute: ({ context }) => context.keep() },
    arm_close: { description: 'Save this draft during the next cleanup', inputSchema: none, execute: ({ context }) => context.arm() },
} });

export function createDraft(storage: AppStatePersistence | undefined, publish: () => unknown | Promise<unknown>) {
    if (!storage) throw Error('The draft App must opt into storage');
    let draft = 'empty', previous = 'unread', saveOnClose = false;
    return {
        body: () => `Draft: ${draft}\nSaved lookup: ${previous}\n`,
        async edit(text: string) { draft = text; await publish(); return success; },
        async save() { await storage.save('draft', draft); return success; },
        async load(adopt: boolean) {
            const loaded = await storage.load('draft');
            previous = typeof loaded === 'string' ? loaded : 'missing';
            if (adopt && typeof loaded === 'string') draft = loaded;
            await publish();
            return success;
        },
        async remove() { await storage.remove('draft'); return success; },
        async keep() { await storage.save('marker', 'preserve'); return success; },
        arm() { saveOnClose = true; return success; },
        async close() { if (saveOnClose) await storage.save('draft', draft); },
    };
}
