import { defineViewTypeTool, defineToolSet, type ArgsOf, type ToolBinding } from '@aotui/sdk';
import Type from 'typebox';
import type { FetchFormat, SearchQuery, SearchResultItem } from '../types.js';

export interface BrowserActions {
    onSearch: (params: SearchQuery) => Promise<{ summary: string; resultCount: number }>;
    onOpenResult: (url: string) => Promise<string>;
    onClearResults: () => void;
    onFetch: (params: { url: string; format?: FetchFormat; timeout?: number }) => Promise<string>;
    onClosePage: () => void;
}

const searchWebInput = Type.Object({
    query: Type.String({ description: 'Web search query' }),
    numResults: Type.Optional(Type.Number({ description: 'Number of results (default 8)' })),
    livecrawl: Type.Optional(Type.String({ description: 'fallback or preferred' })),
    type: Type.Optional(Type.String({ description: 'auto, fast or deep' })),
    contextMaxCharacters: Type.Optional(Type.Number({ description: 'Maximum context characters' })),
}, { additionalProperties: false });

const openResultInput = Type.Object({
    url: Type.String({ description: 'A URL shown in the current result list' }),
}, { additionalProperties: false });

const emptyInput = Type.Object({}, { additionalProperties: false });

const fetchUrlInput = Type.Object({
    url: Type.String({ description: 'URL to fetch' }),
    format: Type.Optional(Type.String({ description: 'text, markdown or html' })),
    timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (maximum 120)' })),
}, { additionalProperties: false });

export function createSearchWebBinding(onSearch: BrowserActions['onSearch']) {
    return ({ execute: async (args: ArgsOf<typeof browserTools.searchWeb>) => {
            try {
                const result = await onSearch({
                    query: args.query,
                    numResults: args.numResults,
                    contextMaxCharacters: args.contextMaxCharacters,
                    livecrawl: args.livecrawl === 'preferred' || args.livecrawl === 'fallback' ? args.livecrawl : undefined,
                    type: args.type === 'fast' || args.type === 'deep' || args.type === 'auto' ? args.type : undefined,
                });
                return { success: true, data: { message: 'Search completed.', result_count: result.resultCount } };
            } catch (error) {
                return { success: false, error: { code: 'SEARCH_FAILED', message: (error as Error).message } };
            }
        } } satisfies ToolBinding<typeof browserTools.searchWeb>);
}

export function createOpenResultBinding(results: SearchResultItem[], onOpenResult: BrowserActions['onOpenResult']) {
    return ({ execute: async ({ url }: ArgsOf<typeof browserTools.openResult>) => {
            if (!results.some(result => result.url === url)) {
                return { success: false, error: { code: 'RESULT_UNAVAILABLE', message: 'That URL is no longer in the current results. Observe the result list again.' } };
            }
            try {
                const viewId = await onOpenResult(url);
                return { success: true, data: { message: 'Result opened.', view_id: viewId } };
            } catch (error) {
                return { success: false, error: { code: 'OPEN_RESULT_FAILED', message: (error as Error).message } };
            }
        } } satisfies ToolBinding<typeof browserTools.openResult>);
}

export function createClearResultsBinding(onClearResults: BrowserActions['onClearResults']) {
    return ({ execute: async () => {
            onClearResults();
            return { success: true, data: { message: 'Search results cleared.' } };
        } } satisfies ToolBinding<typeof browserTools.clearResults>);
}

export function createFetchUrlBinding(onFetch: BrowserActions['onFetch']) {
    return ({ execute: async (args: ArgsOf<typeof browserTools.fetchUrl>) => {
            try {
                const viewId = await onFetch({
                    url: args.url,
                    timeout: args.timeout,
                    format: args.format === 'text' || args.format === 'markdown' || args.format === 'html' ? args.format : undefined,
                });
                return { success: true, data: { message: 'Page fetched.', view_id: viewId } };
            } catch (error) {
                return { success: false, error: { code: 'FETCH_FAILED', message: (error as Error).message } };
            }
        } } satisfies ToolBinding<typeof browserTools.fetchUrl>);
}

export function createClosePageBinding(onClosePage: BrowserActions['onClosePage']) {
    return ({ execute: async () => {
            onClosePage();
            return { success: true, data: { message: 'Page closed.' } };
        } } satisfies ToolBinding<typeof browserTools.closePage>);
}

export const browserTools = defineToolSet({
searchWeb: defineViewTypeTool({
        viewType: 'Search',
        name: 'search_web',
        description: 'Run a web search. Read the results from Search and ResultList Views.',
        inputSchema: searchWebInput,
    }),
openResult: defineViewTypeTool({
        viewType: 'ResultList',
        name: 'open_result',
        description: 'Open a URL from the current result list. Page will contain the fetched content.',
        inputSchema: openResultInput,
    }),
clearResults: defineViewTypeTool({
        viewType: 'ResultList',
        name: 'clear_results',
        description: 'Remove the current result list and its tools.',
        inputSchema: emptyInput,
    }),
fetchUrl: defineViewTypeTool({
        viewType: 'Root',
        name: 'fetch_url',
        description: 'Fetch a URL and show its content in Page.',
        inputSchema: fetchUrlInput,
    }),
closePage: defineViewTypeTool({
        viewType: 'Page',
        name: 'close_page',
        description: 'Close the current Page View and remove its tool.',
        inputSchema: emptyInput,
    })
});
