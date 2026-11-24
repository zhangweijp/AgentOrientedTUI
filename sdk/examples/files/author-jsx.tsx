import { createTUIApp, DynamicView, StaticView, useAppRuntimeContext, useDataRef, useState } from '@aotui/sdk';
import { Directory, File, directoryBody, fileBody, files, refOptions, type FileName } from './files.js';

function FileBody({ name, text, writable }: { name: FileName; text: string; writable: boolean }) {
    const content = useDataRef('content', text, refOptions(writable));
    return <>{fileBody(name, text)}{content('Content')}</>;
}

function App() {
    const { launchConfig, prepareProjection, prepareOpeningProjection } = useAppRuntimeContext();
    const [, setRevision] = useState(0);
    const redraw = () => setRevision(value => value + 1);
    const [workspace] = useState(() => files(launchConfig?.folder, () => prepareProjection(redraw), (open, undo) =>
        prepareOpeningProjection(() => { open(); redraw(); }, () => { undo(); redraw(); })));
    return <>
        <StaticView type={Directory} context={workspace.directory}>{directoryBody}</StaticView>
        {[...workspace.contents].map(([name, text]) => {
            const context = workspace.context(name);
            return <DynamicView key={name} type={File} idPrefix="doc" name={name} context={context} onClose={() => workspace.close(name)}>
                <FileBody name={name} text={text} writable={context.writable} />
            </DynamicView>;
        })}
    </>;
}

export default createTUIApp({ app_name: 'delivered_files', viewTypes: [Directory, File], component: App });
