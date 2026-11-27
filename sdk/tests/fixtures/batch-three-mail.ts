import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { createApp, createView, defineViewType, refParam, type ToolResult, type ViewHandle, type ViewFrame } from '@aotui/sdk';
type FixturePage = { handle: ViewHandle; frame(): ViewFrame };

const Contact = Type.Object({ email: Type.String(), 'display.name': Type.String() }, { additionalProperties: false });
const More = Type.Object({ to: Type.Array(Type.String()), label: Type.String(), priority: Type.Integer(), extra: Type.Unknown() },
    { additionalProperties: false });
const Draft = defineViewType<({ write(label: string, input: Readonly<Record<string, unknown>>): ToolResult }) & { close?: (() => ToolResult) | undefined }>()({ onClose: { enabled: context => !!context.close, execute: ({ context }) => context.close!() },
    name: 'draft', multiplicity: 'multiple', region: 'dynamic',
    tools: {
        set_recipients: { description: 'Set the recipients on the selected local draft.', inputSchema: More,
            execute: ({ context, input }) => context.write('draft', input) },
        choose_contact: { description: 'Select a published contact.',
            inputSchema: Type.Object({ contact: refParam('Contact', Contact) }, { additionalProperties: false }),
            execute: ({ context, input }) => context.write('contact', input) },
        set_priority: { description: 'Set the integer draft priority.',
            inputSchema: Type.Object({ priority: Type.Integer() }, { additionalProperties: false }),
            execute: ({ context, input }) => context.write('priority', input) },
    },
});
const Workspace = defineViewType<{ open(name: string): ToolResult }>()({
    name: 'workspace', multiplicity: 'single', region: 'static',
    tools: { open_draft: { description: 'Open a draft.',
        inputSchema: Type.Object({ name: Type.String() }, { additionalProperties: false }),
        execute: ({ context, input }) => context.open(input.name) } },
});
const frozen = (value: unknown): boolean => value === null || typeof value !== 'object' ||
    Object.isFrozen(value) && Object.values(value).every(frozen);

export default createApp({
    app_name: 'mail',
    viewTypes: [Workspace, Draft],
    initialize({ launchConfig, publish: commit, registerLifecycle }) {
        const configured = launchConfig?.folder;
        if (typeof configured !== 'string') throw new Error('Missing draft folder');
        const folder: string = configured;
        const lifecycle = join(folder, 'mail-lifecycle.jsonl');
        const settings = launchConfig?.settings as { theme?: string } | undefined;
        const drafts = new Map<string, FixturePage>();
        const workspace = (() => { const handle = createView(Workspace); return { handle, frame: () => handle.frame({ body: '# Mail\nTheme: ' + settings?.theme, context: { open(name) {
                if (!drafts.has(name)) drafts.set(name, makeDraft(name));
                publish();
                return { success: true };
            } } }) }; })();
        function makeDraft(name: string) {
            let content = 'Untouched';
            return (() => { const handle = createView(Draft, { idPrefix: 'draft' }); const displayName = name; const closeAction = (): ToolResult => {
                drafts.delete(name);
                publish();
                return { success: true };
            }; return { handle, frame: () => handle.frame({ name: displayName, body: '# ' + name + '\n' + content, context: { ...({ write(label, input) {
                    const value = { label, name, input, frozen: frozen(input), threadId };
                    if (label === 'draft' && typeof input.label === 'string' && input.label === 'fault')
                        throw new Error('Synthetic handler failure');
                    appendFileSync(join(folder, 'draft-handler.jsonl'), JSON.stringify(value) + '\n');
                    content = JSON.stringify(input);
                    writeFileSync(join(folder, name + '.json'), content);
                    appendFileSync(join(folder, 'draft-writes.jsonl'), JSON.stringify(value) + '\n');
                    publish();
                    return { success: true, data: { saved: true } };
                } }), close: closeAction } }) }; })();
        }
        function publish() { commit(() => ([workspace, ...drafts.values()]).map(page => page.frame())); }
        publish();
        appendFileSync(lifecycle, JSON.stringify({ event: 'start', threadId }) + '\n');
        const watcher = setInterval(() => {
            const first = drafts.get('A');
            if (!first || !existsSync(join(folder, 'replace-draft')) || replaced) return;
            replaced = true;
            drafts.set('A', makeDraft('A'));
            publish();
        }, 15);
        let replaced = false;
        registerLifecycle({ stop: () => {
            clearInterval(watcher);
            appendFileSync(lifecycle, JSON.stringify({ event: 'stop', threadId }) + '\n');
        } });
    },
});
