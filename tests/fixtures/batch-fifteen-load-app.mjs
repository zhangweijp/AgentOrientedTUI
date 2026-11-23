import Type from 'typebox';
import { createApp, createView, defineViewType } from '@aotui/sdk/app';

const File = defineViewType()({
    name: 'File', region: 'dynamic', multiplicity: 'multiple', createId: ({ prefix }) => prefix,
    tools: {
        edit_marker: {
            description: 'Change one character in a test document.',
            inputSchema: Type.Object({}, { additionalProperties: false }),
            execute: ({ context }) => context.edit(),
        },
    },
});
export default createApp({
    app_name: 'bench_files',
    viewTypes: [File],
    initialize({ launchConfig, prepareProjection }) {
        const { count, pageBytes } = launchConfig;
        const text = Array.from({ length: count }, () => 'a'.repeat(pageBytes));
        let writes = 0;
        const views = text.map((_, index) => createView(File, {
            idPrefix: 'file_' + index,
            render: () => ({ body: text[index], context: {
                edit() {
                    writes++;
                    text[index] = text[index].slice(0, -1) + (writes % 2 ? 'Z' : 'a');
                    prepareProjection({ views });
                    return { success: true, data: { writes } };
                },
            } }),
        }));
        prepareProjection({ views });
    },
});
