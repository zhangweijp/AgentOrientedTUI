import { useViewTypeTool } from '@aotui/sdk';
import type { LoadedDiagnosticsState } from './loaded-diagnostics.js';

/** View-local read capability with no legacy service initialization. */
export function DiagnosticsReadTool({ state }: { state: LoadedDiagnosticsState }) {
    useViewTypeTool('read_loaded_diagnostics', {
        description: 'Read the currently committed, already loaded diagnostics for this file view. This does not refresh diagnostics.',
        params: {}, isMutating: false,
    }, async () => ({ success: true, data: { ...state } }));
    return null;
}
