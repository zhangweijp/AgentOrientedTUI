import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, createView, formatRef, ref, type ToolResult, type ViewHandle, type ViewFrame } from '@aotui/sdk';
type FixturePage = { handle: ViewHandle; frame(): ViewFrame };
import { fileIO } from './file-io.mjs';
import { Directory, File, fileUnavailable, textSchema } from './files.js';

export default createApp({
    app_name: 'delivered_files', viewTypes: [Directory, File],
    initialize({ launchConfig, publish: commit, registerLifecycle }) {
        if (typeof launchConfig?.folder !== 'string') throw new Error('A fixture folder is required');
        const io = fileIO(launchConfig.folder);
        const signal = join(launchConfig.folder, 'background-b');
        let files = new Map<string, FixturePage>();
        let aWritable = true;
        const frame = (pages = files) => ({ views: [directory, ...pages.values()] });
        const success = { success: true } as const;

        function open(name: string, replace = false): ToolResult {
            const current = io.read(name);
            if (current === undefined) return fileUnavailable;
            if (files.has(name) && !replace) return success;
            let text = current;
            const view = (() => { const handle = createView(File, { idPrefix: 'doc' }); const displayName = name; const closeAction = function() { files.delete(name); commit(() => frame().views.map(page => page.frame())); return success; }; return { handle, frame: () => {
                    const writable = name !== 'A.txt' || aWritable;
                    const content = ref('content', text, { scope: writable ? 'public' : 'private', schema: textSchema });
                    return handle.frame({ name: displayName, body: name + '\n' + text + '\n' + formatRef('Content', content), refs: [content], context: { ...({ writable, write(next) {
                            if (!io.write(name, next)) return fileUnavailable;
                            text = next;
                            commit(() => ((frame()).views).map(page => page.frame()));
                            return success;
                        } }), close: closeAction } });
                } }; })();
            const pages = new Map(files).set(name, view);
            const prepared = commit(() => ((frame(pages)).views).map(page => page.frame()), { mode: 'candidate' });
            if (!prepared.ok)
                return { success: false, error: { code: prepared.issue.code, message: prepared.issue.message } };
            files = pages;
            return success;
        }

        const directory = (() => { const handle = createView(Directory); return { handle, frame: () => handle.frame({ body: 'Files A.txt and B.txt.', context: {
            open,
            reload: () => open('A.txt', true),
            disable() { aWritable = false; commit(() => ((frame()).views).map(page => page.frame())); return success; },
        } }) }; })();
        commit(() => ((frame()).views).map(page => page.frame()));
        let lastSignal: string | undefined;
        const poll = setInterval(() => {
            if (!existsSync(signal)) return;
            const token = readFileSync(signal, 'utf8');
            if (token === lastSignal) return;
            lastSignal = token;
            open('B.txt', true);
        }, 15);
        registerLifecycle({ stop: () => clearInterval(poll) });
    },
});
