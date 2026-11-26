import { defineViewType, type ToolResult } from '@aotui/sdk';
import Type from 'typebox';
import type { FetchFormat, SearchQuery, SearchResultItem } from '../types.js';

export interface BrowserActions {
    onSearch: (params: SearchQuery) => Promise<{ resultCount: number }>;
    onOpenResult: (url: string) => Promise<string>;
    onClearResults: () => void;
    onFetch: (params: { url: string; format?: FetchFormat; timeout?: number }) => Promise<string>;
    onClosePage: () => void;
}

function failure(code: string, error: unknown): ToolResult {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'OBSERVATION_CAPACITY') code = error.code;
    return { success: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
}

type ResultListContext = Pick<BrowserActions, 'onOpenResult' | 'onClearResults'>
    & { readonly results: readonly SearchResultItem[] };

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

export const SearchType = defineViewType<Pick<BrowserActions, 'onSearch'>>()({ name: 'Search', multiplicity: 'single', region: 'dynamic', tools: {
        search_web: { description: 'Run a web search. Read the results from Search and ResultList Views.',
            inputSchema: searchWebInput,
            async execute({ input: args, context: { onSearch } }) {
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
                    return failure('SEARCH_FAILED', error);
                }
            },
        },
} });

export const ResultListType = defineViewType<ResultListContext>()({ name: 'ResultList', multiplicity: 'single', region: 'dynamic', tools: {
        open_result: { description: 'Open a URL from the current result list. Page will contain the fetched content.',
            inputSchema: openResultInput,
            async execute({ input: { url }, context: { results, onOpenResult } }) {
                if (!results.some(result => result.url === url)) {
                    return { success: false, error: { code: 'RESULT_UNAVAILABLE', message: 'That URL is no longer in the current results. Observe the result list again.' } };
                }
                try {
                    const viewId = await onOpenResult(url);
                    return { success: true, data: { message: 'Result opened.', view_id: viewId } };
                } catch (error) {
                    return failure('OPEN_RESULT_FAILED', error);
                }
            },
        },
        clear_results: { description: 'Remove the current result list and its tools.',
            inputSchema: emptyInput,
            async execute({ context: { onClearResults } }) {
                onClearResults();
                return { success: true, data: { message: 'Search results cleared.' } };
            },
        },
} });

export const RootType = defineViewType<Pick<BrowserActions, 'onFetch'>>()({ name: 'Root', multiplicity: 'single', region: 'static', tools: {
        fetch_url: { description: 'Fetch a URL and show its content in Page.',
            inputSchema: fetchUrlInput,
            async execute({ input: args, context: { onFetch } }) {
                try {
                    const viewId = await onFetch({
                        url: args.url,
                        timeout: args.timeout,
                        format: args.format === 'text' || args.format === 'markdown' || args.format === 'html' ? args.format : undefined,
                    });
                    return { success: true, data: { message: 'Page fetched.', view_id: viewId } };
                } catch (error) {
                    return failure('FETCH_FAILED', error);
                }
            },
        },
} });

export const PageType = defineViewType<Pick<BrowserActions, 'onClosePage'>>()({ name: 'Page', multiplicity: 'single', region: 'dynamic', tools: {
        close_page: { description: 'Close the current Page View and remove its tool.',
            inputSchema: emptyInput,
            async execute({ context: { onClosePage } }) {
                onClosePage();
                return { success: true, data: { message: 'Page closed.' } };
            },
        },
} });

export const browserViewTypes = [SearchType, ResultListType, RootType, PageType] as const;
