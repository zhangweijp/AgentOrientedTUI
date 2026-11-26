import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { createRuntime, type RunningApp } from '@aotui/runtime';

function appSource(): string {
    return `
        import Type from 'typebox';
        import { createApp, createView, defineViewType } from '@aotui/sdk';
        const EmptyType = defineViewType()({ multiplicity: 'multiple', name: 'EmptyType', tools: {
            ping: {
                description: 'Ping the empty View type.', inputSchema: Type.Object({}, { additionalProperties: false }),
                execute: async () => ({ success: true, data: { pong: true } }),
            },
            set_body: {
                description: 'Update one View body.',
                inputSchema: Type.Object({ body: Type.String() }, { additionalProperties: false }),
                async execute({ input, context: { setBody } }) {
                    setBody(input.body);
                    return { success: true };
                },
            },
        } });
        const HealthyType = defineViewType({ multiplicity: 'multiple', name: 'HealthyType' });

        export default createApp({ viewTypes: [EmptyType, HealthyType], app_name: 'empty_app',
            initialize({ prepareProjection }) {
                function page(idPrefix, initial) {
                    let body = initial;
                    return createView(EmptyType, { idPrefix, region: 'dynamic', render: () => ({
                        body, context: { setBody(next) { body = next; publish(); } },
                    }) });
                }
                const views = [
                    createView(HealthyType, { idPrefix: 'healthy_view', region: 'dynamic', render: () => ({ body: 'HEALTHY_SIBLING_BODY' }) }),
                    page('no_children', ''), page('whitespace', '  \\n  '), page('conditional', ''),
                ];
                function publish() { prepareProjection({ views }); }
                publish();
            }
        });
    `;
}

async function writeApp(directory: string): Promise<string> {
    const modules = join(directory, 'node_modules');
    await mkdir(join(modules, '@aotui'), { recursive: true });
    await symlink(fileURLToPath(new URL('../../sdk/', import.meta.url)), join(modules, '@aotui/sdk'), 'dir');
    await symlink(fileURLToPath(new URL('../../sdk/node_modules/typebox', import.meta.url)), join(modules, 'typebox'), 'dir');
    const app = join(directory, 'app.mjs');
    await writeFile(app, appSource(), 'utf8');
    return app;
}

async function preview(app: RunningApp) {
    const result = await app.preview();
    if (result.status !== 'previewed') throw new Error(result.issue.message);
    return result;
}

function viewMessage(context: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>>, id: string): string {
    const message = context.messages.find(item => String(item.content).startsWith(`<view view_id="${id}"`));
    if (!message) throw new Error(`Missing View message ${id}`);
    return String(message.content);
}

function viewBodyFromMessage(markup: string): string {
    const open = markup.indexOf('>\n');
    const close = markup.lastIndexOf('\n</view>');
    if (open < 0 || close < open) throw new Error('View message has no complete outer envelope');
    return markup.slice(open + 2, close);
}

describe('empty View projection in a real Worker and Semantic Source', () => {
    it('keeps empty and whitespace-only Views, their Tools and subsequent body updates', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'aotui-empty-view-'));
        const runtime = createRuntime();
        let source: SemanticAOTUIDrivenSource | undefined;
        let context: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>> | undefined;
        try {
            const desktop = await runtime.createDesktop('empty_desktop');
            const app = await desktop.installDynamicWorkerApp(await writeApp(directory), { name: 'empty_app' });
            source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
            const observe = async () => {
                context = await source!.getContext();
                await context.adopt!();
                return context;
            };
            const result = async (name: string, input: Record<string, unknown>, callId: string) => {
                const current = context!;
                const value = await current.executeTool!(name, input, callId);
                expect(value).toMatchObject({ outcomeStatus: 'succeeded' });
                await current.release?.();
                context = undefined;
                return value;
            };

            let current = await observe();
            expect(Object.keys(current.tools)).toEqual(expect.arrayContaining([
                'empty_app-ping', 'empty_app-set_body',
            ]));
            expect(current.messages.filter(message => String(message.content).startsWith('<view '))).toHaveLength(4);
            expect(viewMessage(current, 'healthy_view_1')).toContain('HEALTHY_SIBLING_BODY');
            const initialViews = (await preview(app)).views;
            expect(initialViews.find((view: any) => view.id === 'healthy_view_1')?.content.value).toContain('HEALTHY_SIBLING_BODY');
            for (const [id, value] of Object.entries({ no_children_1: '', whitespace_1: '  \n  ', conditional_1: '' })) {
                expect(viewBodyFromMessage(viewMessage(current, id))).toBe(value);
                expect(initialViews.find((view: any) => view.id === id)?.content.value).toBe(value);
            }

            await result('empty_app-ping', { view_id: 'no_children_1' }, 'empty-ping');
            const initialRevision = (await preview(app)).source.revision;
            for (const [index, body] of ['EMPTY_VIEW_BODY_ONE', '', 'EMPTY_VIEW_BODY_TWO'].entries()) {
                current = await observe();
                expect(current.tools['empty_app-ping']).toBeDefined();
                expect(current.tools['empty_app-set_body']).toBeDefined();
                await result('empty_app-set_body', { view_id: 'no_children_1', body }, `set-body-${index}`);
                current = await observe();
                const snapshot = await preview(app);
                expect(snapshot.source.revision).toBeGreaterThan(initialRevision + index);
                expect(snapshot.views.find(view => view.id === 'no_children_1')?.content.value).toBe(body);
                expect(current.tools['empty_app-ping']).toBeDefined();
                expect(viewBodyFromMessage(viewMessage(current, 'no_children_1'))).toBe(body);
                expect(viewMessage(current, 'healthy_view_1')).toContain('HEALTHY_SIBLING_BODY');
                await current.release?.();
                context = undefined;
            }
            source.dispose();
            source = undefined;
            expect(await app.beginClose().completion).toMatchObject({
                state: 'settled', worker: 'exited', resourcesReleased: true,
                appCleanup: { managedApps: 1, completedApps: 1, failedApps: 0 },
                interactions: { verified: true, retainedOperations: 0 },
            });
        } finally {
            await context?.release?.();
            source?.dispose();
            await runtime.beginClose().completion;
            await rm(directory, { recursive: true, force: true });
        }
    }, 25_000);
});
