import { createApp, createView, formatRef, ref, type ToolResult, type ViewHandle } from '@aotui/sdk';
import { fileIO } from './file-io.mjs';
import { Directory, File, fileUnavailable, textSchema } from './files.js';

type OpenFile = { readonly view: ViewHandle; readonly text: string };
type Workspace = { readonly files: ReadonlyMap<string, OpenFile>; readonly aWritable: boolean };
const success = { success: true } as const;

export default createApp({
    app_name: 'delivered_files', viewTypes: [Directory, File],
    initialize({ launchConfig, prepareProjection, prepareOpeningProjection, readViewId }) {
        if (typeof launchConfig?.folder !== 'string' || !launchConfig.folder) throw new Error('Set config.folder to a directory.');
        const io = fileIO(launchConfig.folder);
        let current: Workspace = { files: new Map(), aWritable: true };
        let rendering = current;

        function publish(candidate: Workspace, opening = false) {
            rendering = candidate;
            try {
                const frame = { views: [directory, ...Array.from(candidate.files.values(), file => file.view)] };
                const result = opening ? prepareOpeningProjection(frame) : prepareProjection(frame);
                if (result.status === 'prepared') current = candidate;
                return result;
            } finally {
                rendering = current;
            }
        }

        function open(name: string): ToolResult {
            const text = io.read(name);
            if (text === undefined) return fileUnavailable;
            let file = current.files.get(name);
            if (!file) {
                file = { view: filePage(name), text };
                const result = publish({ ...current, files: new Map(current.files).set(name, file) }, true);
                if (result.status === 'rejected') {
                    return { success: false, error: { code: result.issue.code, message: 'Close one file before opening another.' } };
                }
            }
            const viewId = readViewId(file.view);
            return viewId === undefined ? success : { success: true, data: { view_id: viewId } };
        }

        const directory = createView(Directory, {
            render: () => ({
                body: 'Files: ' + (io.list().join(', ') || 'none') +
                    '\nOpen files: ' + ([...rendering.files.keys()].join(', ') || 'none'),
                context: {
                    open,
                    reload() {
                        const file = current.files.get('A.txt');
                        if (!file) return open('A.txt');
                        const text = io.read('A.txt');
                        if (text === undefined) return fileUnavailable;
                        publish({ ...current, files: new Map(current.files).set('A.txt', { ...file, text }) });
                        return success;
                    },
                    disable() {
                        publish({ ...current, aWritable: false });
                        return success;
                    },
                },
            }),
        });

        const filePage = (name: string) => createView(File, {
            idPrefix: 'doc', name,
            onClose() {
                const files = new Map(current.files);
                files.delete(name);
                publish({ ...current, files });
                return success;
            },
            render() {
                const { text } = rendering.files.get(name)!;
                const writable = name !== 'A.txt' || rendering.aWritable;
                const content = ref('content', text, { scope: writable ? 'public' : 'private', schema: textSchema });
                return {
                    body: `${name}\n${text}\n${formatRef('Content', content)}`,
                    refs: [content],
                    context: {
                        writable,
                        write(next) {
                            if (!io.write(name, next)) return fileUnavailable;
                            const file = current.files.get(name)!;
                            current = { ...current, files: new Map(current.files).set(name, { ...file, text: next }) };
                            try { publish(current); }
                            catch { return { success: true, data: { projection: 'failed' } }; }
                            return success;
                        },
                    },
                };
            },
        });
        publish(current);
    },
});
