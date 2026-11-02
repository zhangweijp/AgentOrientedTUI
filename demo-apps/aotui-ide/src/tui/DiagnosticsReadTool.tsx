import { useViewTypeTool } from '@aotui/sdk';
import type { LoadedDiagnosticsState } from './loaded-diagnostics.js';

/** View-local read capability with no legacy service initialization. */
export function DiagnosticsReadTool({ state }: { state: LoadedDiagnosticsState }) {
    useViewTypeTool('read_loaded_diagnostics', {
        description: 'Read the currently committed, already loaded diagnostics for this file view. This does not refresh diagnostics.',
        params: { filePath: { type: 'string', required: true } }, isMutating: false,
        target: { param: 'filePath', value: state.filePath },
    }, async () => ({ success: true, data: { message: 'Read the loaded diagnostics in this FileDetail View.', filePath: state.filePath, status: state.status } }));
    return null;
}
