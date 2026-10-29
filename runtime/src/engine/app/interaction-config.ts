import { copyJson } from '../../core/snapshot/json.js';
import type { AppInteractionOptions, InteractionMode } from '../../spi/runtime/app-interaction.interface.js';
import { SEMANTIC_INTERACTION_MODES as modes } from '../../spi/runtime/app-interaction.interface.js';

/** Capture only the trusted host field, before allocating or transferring ownership. */
export function captureInteractionModes(options?: AppInteractionOptions): readonly InteractionMode[] | undefined {
    try {
        const field = options === undefined ? undefined : Object.getOwnPropertyDescriptor(options, 'experimentalInteractionModes');
        if (!field) return undefined;
        if (!('value' in field) || !field.enumerable) throw new Error();
        if (field.value === undefined) return undefined;
        if (!Array.isArray(field.value) || field.value.length > 5) throw new Error();
        const value = copyJson(field.value, { maxDepth: 1, maxNodes: 6, maxApproxBytes: 256 });
        if (!Array.isArray(value) || value.length > 5 || new Set(value).size !== value.length || value.some(item => !modes.includes(item as InteractionMode))) throw new Error();
        return Object.freeze(modes.filter(mode => value.includes(mode)));
    } catch { throw Object.assign(new Error('Invalid experimental interaction modes'), { code: 'INTERACTION_MODES_INVALID' }); }
}
