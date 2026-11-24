import { createApp, createView, formatRef, ref } from '@aotui/sdk/app';
import { Directory, File, directoryBody, fileBody, files, names, refOptions } from './files.js';

export default createApp({
    app_name: 'delivered_files', viewTypes: [Directory, File],
    initialize({ launchConfig, prepareProjection, prepareOpeningProjection }) {
        const workspace = files(launchConfig?.folder, () => { prepareProjection(frame()); }, (open, undo) => {
            open();
            try { prepareOpeningProjection(frame()); }
            catch (error) { undo(); throw error; }
        });
        const directory = createView(Directory, { render: () => ({ body: directoryBody, context: workspace.directory }) });
        const pages = new Map(names.map(name => [name, createView(File, { idPrefix: 'doc', name, onClose: () => workspace.close(name), render() {
            const text = workspace.contents.get(name)!;
            const context = workspace.context(name);
            const content = ref('content', text, refOptions(context.writable));
            return { body: fileBody(name, text) + formatRef('Content', content), refs: [content], context };
        } })]));
        const frame = () => ({ views: [directory, ...[...workspace.contents.keys()].map(name => pages.get(name)!)] });
        prepareProjection(frame());
    },
});
