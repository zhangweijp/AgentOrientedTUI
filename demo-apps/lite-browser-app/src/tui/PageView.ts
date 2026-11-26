import type { PageState } from '../types.js';

export function literalBlock(text: string): string {
    let width = 3;
    for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
    const fence = '`'.repeat(width);
    return `${fence}\n${text}\n${fence}`;
}

export function pageBody({ status, error, document }: PageState): string {
    const body = ['## Page', 'Status: ' + status];
    if (error) body.push('Error: ' + error);
    if (document) {
        body.push('URL: ' + document.url, 'Content Type: ' + (document.contentType || 'unknown'), 'Format: ' + document.format);
        body.push(literalBlock(document.content));
    }
    return body.join('\n\n');
}
