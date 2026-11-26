import type { SearchState } from '../types.js';
import { literalBlock } from './PageView.js';

export function searchBody(state: SearchState): string {
    return [
        '## Search',
        'Status: ' + state.status,
        ...(state.query ? ['Query: ' + state.query.query] : []),
        ...(state.error ? ['Error: ' + state.error] : []),
        ...(state.summary ? [literalBlock(state.summary)] : []),
    ].join('\n\n');
}
