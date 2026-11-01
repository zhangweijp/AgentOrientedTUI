import { defineParams, useViewTypeTool } from '@aotui/sdk';
import type { FetchFormat, SearchQuery, SearchResultItem } from '../types.js';

export interface BrowserActions {
    onSearch: (params: SearchQuery) => Promise<{ summary: string; resultCount: number }>;
    onOpenResult: (url: string) => Promise<string>;
    onClearResults: () => void;
    onFetch: (params: { url: string; format?: FetchFormat; timeout?: number }) => Promise<string>;
    onClosePage: () => void;
}

export function SearchToolSection({ onSearch }: Pick<BrowserActions, 'onSearch'>) {
    useViewTypeTool('search_web', {
        description: 'Run a web search. Read the results from Search and ResultList Views.',
        params: defineParams({
            query: { type: 'string', required: true, desc: 'Web search query' },
            numResults: { type: 'number', required: false, desc: 'Number of results (default 8)' },
            livecrawl: { type: 'string', required: false, desc: 'fallback or preferred' },
            type: { type: 'string', required: false, desc: 'auto, fast or deep' },
            contextMaxCharacters: { type: 'number', required: false, desc: 'Maximum context characters' },
        }), isMutating: true,
    }, async args => {
        try {
            const result = await onSearch({
                query: args.query, numResults: args.numResults, contextMaxCharacters: args.contextMaxCharacters,
                livecrawl: args.livecrawl === 'preferred' || args.livecrawl === 'fallback' ? args.livecrawl : undefined,
                type: args.type === 'fast' || args.type === 'deep' || args.type === 'auto' ? args.type : undefined,
            });
            return { success: true, data: { message: 'Search completed.', result_count: result.resultCount } };
        } catch (error) {
            return { success: false, error: { code: 'SEARCH_FAILED', message: (error as Error).message } };
        }
    });
    return null;
}

export function ResultListToolSection({ results, onOpenResult, onClearResults }:
    { results: SearchResultItem[] } & Pick<BrowserActions, 'onOpenResult' | 'onClearResults'>) {
    useViewTypeTool('open_result', {
        description: 'Open a URL from this current result list. Page will contain the fetched content.',
        params: defineParams({ url: { type: 'string', required: true, desc: 'A URL shown in this result list' } }),
        isMutating: true,
    }, async ({ url }) => {
        if (!results.some(result => result.url === url)) {
            return { success: false, error: { code: 'RESULT_UNAVAILABLE', message: 'That URL is no longer in the current results. Observe the result list again.' } };
        }
        try {
            const viewId = await onOpenResult(url);
            return { success: true, data: { message: 'Result opened.', view_id: viewId } };
        } catch (error) {
            return { success: false, error: { code: 'OPEN_RESULT_FAILED', message: (error as Error).message } };
        }
    });
    useViewTypeTool('clear_results', {
        description: 'Remove the current result list and its tools.', params: defineParams({}), isMutating: true,
    }, async () => {
        onClearResults();
        return { success: true, data: { message: 'Search results cleared.' } };
    });
    return null;
}

export function FetchToolSection({ onFetch }: Pick<BrowserActions, 'onFetch'>) {
    useViewTypeTool('fetch_url', {
        description: 'Fetch a URL and show its content in Page.',
        params: defineParams({
            url: { type: 'string', required: true, desc: 'URL to fetch' },
            format: { type: 'string', required: false, desc: 'text, markdown or html' },
            timeout: { type: 'number', required: false, desc: 'Timeout in seconds (maximum 120)' },
        }), isMutating: true,
    }, async args => {
        try {
            const viewId = await onFetch({ url: args.url, timeout: args.timeout,
                format: args.format === 'text' || args.format === 'markdown' || args.format === 'html' ? args.format : undefined });
            return { success: true, data: { message: 'Page fetched.', view_id: viewId } };
        } catch (error) {
            return { success: false, error: { code: 'FETCH_FAILED', message: (error as Error).message } };
        }
    });
    return null;
}

export function PageToolSection({ onClosePage }: Pick<BrowserActions, 'onClosePage'>) {
    useViewTypeTool('close_page', {
        description: 'Close this Page View and remove its tools.', params: defineParams({}), isMutating: true,
    }, async () => {
        onClosePage();
        return { success: true, data: { message: 'Page closed.' } };
    });
    return null;
}
