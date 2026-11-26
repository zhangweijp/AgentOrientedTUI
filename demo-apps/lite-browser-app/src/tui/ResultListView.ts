import type { SearchResultItem } from '../types.js';

export function resultListBody(results: readonly SearchResultItem[]): string {
    return [
        '## Search Results',
        'Total: ' + results.length,
        ...results.map(result => [
            '- ' + (result.title || result.url),
            '  ' + result.url,
            ...(result.snippet ? ['  ' + result.snippet] : []),
        ].join('\n')),
    ].join('\n\n');
}
