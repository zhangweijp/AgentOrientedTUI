import { createApp, createView, formatRef, ref, type ToolResult, type ViewHandle } from '@aotui/sdk';
import { fileIO } from './file-io.mjs';
import { Directory, File, fileUnavailable, textSchema } from './files.js';

type OpenFile = { readonly view: ViewHandle<typeof File>; readonly text: string };
type Workspace = { readonly files: ReadonlyMap<string, OpenFile>; readonly aWritable: boolean };
const success = { success: true } as const;
const directory = createView(Directory);

export default createApp({
    app_name: 'delivered_files', viewTypes: [Directory, File],
    initialize(app) {
        const { launchConfig, readViewId } = app;
        if (typeof launchConfig?.folder !== 'string' || !launchConfig.folder) throw new Error('Set config.folder to a directory.');
        const io = fileIO(launchConfig.folder);
        let current: Workspace = { files: new Map(), aWritable: true };

        function frames(state: Workspace) {
            return [directory.frame({
                body: 'Files: ' + (io.list().join(', ') || 'none') +
                    '\nOpen files: ' + ([...state.files.keys()].join(', ') || 'none'),
                context: { open, reload, disable },
            }), ...Array.from(state.files, ([name, file]) => {
                const writable = name !== 'A.txt' || state.aWritable;
                const content = ref('content', file.text, { scope: writable ? 'public' : 'private', schema: textSchema });
                return file.view.frame({
                    name, body: name + '\n' + file.text + '\n' + formatRef('Content', content), refs: [content],
                    bindingKey: name, context: { writable, write: next => write(name, next), close: () => close(name) },
                });
            })];
        }

        function open(name: string): ToolResult {
            const text = io.read(name);
            if (text === undefined) return fileUnavailable;
            const existing = current.files.get(name);
            if (existing) {
                const id = readViewId(existing.view);
                return id === undefined ? success : { success: true, data: { view_id: id } };
            }
            const file = { view: createView(File, { idPrefix: 'doc' }), text };
            const next = { ...current, files: new Map(current.files).set(name, file) };
            const result = app.publish(() => frames(next), { mode: 'candidate' });
            if (!result.ok) return { success: false, error: { code: result.issue.code, message: 'Close one file before opening another.' } };
            current = next;
            const id = result.viewId(file.view);
            return id === undefined ? success : { success: true, data: { view_id: id } };
        }
        function refresh(): ToolResult {
            const result = app.publish(() => frames(current));
            return result.ok ? success : { success: true, data: { projection: 'failed', issue: result.issue.code } };
        }
        function reload(): ToolResult {
            const file = current.files.get('A.txt');
            if (!file) return open('A.txt');
            const text = io.read('A.txt');
            if (text === undefined) return fileUnavailable;
            current = { ...current, files: new Map(current.files).set('A.txt', { ...file, text }) };
            return refresh();
        }
        function disable(): ToolResult {
            current = { ...current, aWritable: false };
            return refresh();
        }
        function write(name: string, text: string): ToolResult {
            const file = current.files.get(name);
            if (!file || !io.write(name, text)) return fileUnavailable;
            current = { ...current, files: new Map(current.files).set(name, { ...file, text }) };
            return refresh();
        }
        function close(name: string): ToolResult {
            const files = new Map(current.files);
            files.delete(name);
            const next = { ...current, files };
            const result = app.publish(() => frames(next), { mode: 'candidate' });
            if (!result.ok) return { success: false, error: result.issue };
            current = next;
            return success;
        }
        refresh();
    },
});
