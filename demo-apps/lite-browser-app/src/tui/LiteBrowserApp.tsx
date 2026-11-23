import { createTUIApp, useCallback, useState } from '@aotui/sdk';
import { runWebFetch } from '../core/webfetch.js';
import { runWebSearch } from '../core/websearch.js';
import type { FetchFormat, PageState, SearchQuery, SearchState } from '../types.js';
import { PageView } from './PageView.js';
import { ResultListView } from './ResultListView.js';
import { RootView } from './RootView.js';
import { SearchView } from './SearchView.js';
import {
    RootType, SearchType, ResultListType, PageType, browserViewTypes,
} from './BrowserTools.js';

function LiteBrowserRoot() {
    const [searchState, setSearchState] = useState<SearchState>({
        status: 'idle',
        results: []
    });
    const [pageState, setPageState] = useState<PageState>({
        status: 'idle'
    });

    const handleSearch = useCallback(async (params: SearchQuery) => {
        try {
            const { summary, results } = await runWebSearch(params);
            setSearchState({
                status: 'success',
                query: params,
                summary,
                results,
                updatedAt: Date.now()
            });
            return { summary, resultCount: results.length };
        } catch (error) {
            const message = (error as Error).message;
            setSearchState({
                status: 'error',
                query: params,
                error: message,
                results: []
            });
            throw error;
        }
    }, []);

    const handleFetch = useCallback(
        async (params: { url: string; format?: FetchFormat; timeout?: number }) => {
            try {
                const document = await runWebFetch(params);
                setPageState({ status: 'success', document });
                return 'page';
            } catch (error) {
                const message = (error as Error).message;
                setPageState({ status: 'error', error: message });
                throw error;
            }
        },
        []
    );

    const handleOpenResult = useCallback(
        async (url: string) => {
            return handleFetch({ url, format: 'markdown' });
        },
        [handleFetch]
    );

    const handleClearResults = useCallback(() => {
        setSearchState({
            status: 'idle',
            results: []
        });
    }, []);

    const handleClosePage = useCallback(() => {
        setPageState({ status: 'idle' });
    }, []);

    const hasResults = searchState.results.length > 0;
    const hasPage = pageState.status !== 'idle';

    return (
        <>
            <RootType id="root" context={{ onFetch: handleFetch }} name="Root">
                <RootView />
            </RootType>
            <SearchType id="search" context={{ onSearch: handleSearch }} name="Search">
                <SearchView state={searchState} />
            </SearchType>
            {hasResults ? (
                <ResultListType key={searchState.updatedAt} id="results"
                    context={{ results: searchState.results, onOpenResult: handleOpenResult, onClearResults: handleClearResults }} name="Result List">
                    <ResultListView results={searchState.results} />
                </ResultListType>
            ) : null}
            {hasPage ? (
                <PageType key={pageState.document?.url ?? 'error'} id="page" context={{ onClosePage: handleClosePage }} name="Page">
                    <PageView state={pageState} />
                </PageType>
            ) : null}
        </>
    );
}

const browserApp: ReturnType<typeof createTUIApp> = createTUIApp({
    app_name: 'lite_browser',
    whatItIs: 'A lightweight TUI browser that runs web searches and fetches URL content into structured views for LLM workflows.',
    whenToUse: 'Use Lite Browser when you need to search the web for current information and fetch specific URLs into a readable format.',
    component: LiteBrowserRoot,
    viewTypes: browserViewTypes,
    signalPolicy: 'auto'
});

export default browserApp;
