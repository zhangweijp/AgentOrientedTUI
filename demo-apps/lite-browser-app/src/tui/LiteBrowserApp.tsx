import { createTUIApp, View, useCallback, useState } from '@aotui/sdk';
import { runWebFetch } from '../core/webfetch.js';
import { runWebSearch } from '../core/websearch.js';
import type { FetchFormat, PageState, SearchQuery, SearchState } from '../types.js';
import { PageView } from './PageView.js';
import { ResultListView } from './ResultListView.js';
import { RootView } from './RootView.js';
import { SearchView } from './SearchView.js';
import { SearchToolSection, ResultListToolSection, PageToolSection } from './BrowserTools.js';

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
            <View id="root" type="Root" name="Root">
                <RootView onFetch={handleFetch} />
            </View>
            <View id="search" type="Search" name="Search">
                <SearchView state={searchState} />
                <SearchToolSection onSearch={handleSearch} />
            </View>
            {hasResults ? (
                <View key={searchState.updatedAt} id="results" type="ResultList" name="Result List">
                    <ResultListView results={searchState.results} />
                    <ResultListToolSection results={searchState.results} onOpenResult={handleOpenResult} onClearResults={handleClearResults} />
                </View>
            ) : null}
            {hasPage ? (
                <View key={pageState.document?.url ?? 'error'} id="page" type="Page" name="Page">
                    <PageView state={pageState} />
                    <PageToolSection onClosePage={handleClosePage} />
                </View>
            ) : null}
        </>
    );
}

export default createTUIApp({
    app_name: 'lite_browser',
    whatItIs: 'A lightweight TUI browser that runs web searches and fetches URL content into structured views for LLM workflows.',
    whenToUse: 'Use Lite Browser when you need to search the web for current information and fetch specific URLs into a readable format.',
    component: LiteBrowserRoot,
    signalPolicy: 'auto'
});
