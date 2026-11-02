import { copyJson } from '../../core/snapshot/json.js';
import type { AppInteractionOptions, InteractionMode } from '../../spi/runtime/app-interaction.interface.js';
import { SEMANTIC_INTERACTION_MODES as modes } from '../../spi/runtime/app-interaction.interface.js';

/** Capture only the trusted host field, before allocating or transferring ownership. */
export function captureInteractionModes(options?: AppInteractionOptions): readonly InteractionMode[] | undefined {
    try {
        const field = options === undefined ? undefined : Object.getOwnPropertyDescriptor(options, 'interactionModes');
        if (!field) return undefined;
        if (!('value' in field) || !field.enumerable) throw new Error();
        if (field.value === undefined) return undefined;
        if (!Array.isArray(field.value) || field.value.length > modes.length) throw new Error();
        const value = copyJson(field.value, { maxDepth: 1, maxNodes: modes.length + 1, maxApproxBytes: 128 });
        if (!Array.isArray(value) || value.length > modes.length || new Set(value).size !== value.length || value.some(item => !modes.includes(item as InteractionMode))) throw new Error();
        return Object.freeze(modes.filter(mode => value.includes(mode)));
    } catch { throw Object.assign(new Error('Invalid interaction modes'), { code: 'INTERACTION_MODES_INVALID' }); }
}
