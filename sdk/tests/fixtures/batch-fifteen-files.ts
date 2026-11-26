import { appendFileSync, existsSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import Type from 'typebox';
import { createApp, createView, defineViewType, formatRef, ref, type ToolResult } from '@aotui/sdk';

const Workspace = defineViewType<{ open(): ToolResult }>()({
    name: 'workspace', multiplicity: 'single', region: 'static',
    tools: { open_file: { description: 'Open the test file.', execute: ({ context }) => context.open() } },
});
const Editor = defineViewType<{ write(text: string): ToolResult; fail(): ToolResult }>()({
    name: 'editor', multiplicity: 'single', region: 'dynamic',
    tools: {
        append_and_fail_projection: {
            description: 'Append to the test file and exercise a projection failure.',
            inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
            execute: ({ input, context }) => context.write(input.text),
        },
        read_file: {
            description: 'Check the selected file contents.',
            inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
            execute: ({ input }) => ({ success: true, data: { text: input.text } }),
        },
        fail_projection: {
            description: 'Exercise a projection failure without changing the file.',
            execute: ({ context }) => context.fail(),
        },
    },
});
const success = () => ({ success: true as const });

const app: ReturnType<typeof createApp> = createApp({
    app_name: 'refresh_files',
    viewTypes: [Workspace, Editor],
    initialize({ appId, launchConfig, prepareProjection, registerCleanup }) {
        const folder = launchConfig?.folder;
        if (typeof folder !== 'string') throw new Error('Missing test file folder');
        const path = join(folder, appId + '.txt');
        const repair = appId + '.repair';
        let failed = existsSync(join(folder, appId + '.initial-fault'));
        let editor: ReturnType<typeof openEditor> | undefined;
        const workspace = createView(Workspace, { render: () => ({
            body: 'Test file workspace',
            context: { open() { editor ??= openEditor(); publish(); return success(); } },
        }) });
        function publish() { prepareProjection({ views: editor ? [workspace, editor] : [workspace] }); }
        function publishFault() {
            failed = true;
            try { publish(); }
            catch (error) {
                if (!(error instanceof Error) || !('code' in error) || error.code !== 'SNAPSHOT_SERIALIZATION_ERROR') throw error;
                return error.code;
            }
            throw new Error('The invalid Ref unexpectedly committed');
        }
        function openEditor() {
            return createView(Editor, {
                onClose: () => { editor = undefined; publish(); return success(); },
                render: () => {
                    const text = readFileSync(path, 'utf8');
                    // @ts-expect-error Exercise Runtime validation of a non-JSON Ref from a JavaScript App.
                    const content = ref('content', failed ? () => text : text, { schema: Type.String(), scope: 'protected' });
                    return {
                        body: 'File body\n\n' + text + '\n\n' + formatRef('File contents', content),
                        refs: [content],
                        context: {
                            write(next) {
                                appendFileSync(path, next + '\n');
                                return { success: true, data: { saved: true, projection: publishFault() } };
                            },
                            fail: () => ({ success: true, data: { projection: publishFault() } }),
                        },
                    };
                },
            });
        }
        editor = openEditor();
        if (failed) publishFault();
        else publish();
        const watcher = watch(folder, { persistent: false }, (_event, name) => {
            if (name !== repair || !failed) return;
            failed = false;
            publish();
        });
        registerCleanup({ close: () => watcher.close() });
    },
});
export default app;
