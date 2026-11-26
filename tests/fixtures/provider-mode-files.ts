import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, createView, formatRef, ref, type ToolResult, type ViewHandle } from '@aotui/sdk';
import { fileIO } from './file-io.mjs';
import { Directory, File, fileUnavailable, textSchema } from './files.js';

export default createApp({
    app_name: 'delivered_files', viewTypes: [Directory, File],
    initialize({ launchConfig, prepareProjection, prepareOpeningProjection, registerCleanup }) {
        if (typeof launchConfig?.folder !== 'string') throw new Error('A fixture folder is required');
        const io = fileIO(launchConfig.folder);
        const signal = join(launchConfig.folder, 'background-b');
        let files = new Map<string, ViewHandle>();
        let aWritable = true;
        const frame = (pages = files) => ({ views: [directory, ...pages.values()] });
        const success = { success: true } as const;

        function open(name: string, replace = false): ToolResult {
            const current = io.read(name);
            if (current === undefined) return fileUnavailable;
            if (files.has(name) && !replace) return success;
            let text = current;
            const view = createView(File, { name, idPrefix: 'doc',
                onClose() { files.delete(name); prepareProjection(frame()); return success; },
                render() {
                    const writable = name !== 'A.txt' || aWritable;
                    const content = ref('content', text, { scope: writable ? 'public' : 'private', schema: textSchema });
                    return { body: name + '\n' + text + '\n' + formatRef('Content', content), refs: [content],
                        context: { writable, write(next) {
                            if (!io.write(name, next)) return fileUnavailable;
                            text = next;
                            prepareProjection(frame());
                            return success;
                        } },
                    };
                },
            });
            const pages = new Map(files).set(name, view);
            const prepared = prepareOpeningProjection(frame(pages));
            if (prepared.status === 'rejected')
                return { success: false, error: { code: prepared.issue.code, message: prepared.issue.message } };
            files = pages;
            return success;
        }

        const directory = createView(Directory, { render: () => ({ body: 'Files A.txt and B.txt.', context: {
            open,
            reload: () => open('A.txt', true),
            disable() { aWritable = false; prepareProjection(frame()); return success; },
        } }) });
        prepareProjection(frame());
        let lastSignal: string | undefined;
        const poll = setInterval(() => {
            if (!existsSync(signal)) return;
            const token = readFileSync(signal, 'utf8');
            if (token === lastSignal) return;
            lastSignal = token;
            open('B.txt', true);
        }, 15);
        registerCleanup({ stop: () => clearInterval(poll) });
    },
});
