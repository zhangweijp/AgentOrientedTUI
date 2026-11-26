import pkg from '../../package.json' with { type: 'json' };
import { createApp, createView, type ViewHandle } from '@aotui/sdk';
import { runWebFetch } from '../core/webfetch.js';
import { runWebSearch } from '../core/websearch.js';
import type { FetchFormat, PageState, SearchQuery, SearchState } from '../types.js';
import { pageBody } from './PageView.js';
import { resultListBody } from './ResultListView.js';
import { rootBody } from './RootView.js';
import { searchBody } from './SearchView.js';
import { RootType, SearchType, ResultListType, PageType, browserViewTypes } from './BrowserTools.js';

export default createApp({
    ...pkg.aotui,
    viewTypes: browserViewTypes,
    initialize({ prepareProjection, prepareOpeningProjection, readViewId }) {
        type BrowserState = { search: SearchState; results?: ViewHandle; page?: { state: PageState; view: ViewHandle } };
        let current: BrowserState = { search: { status: 'idle', results: [] } };
        let candidate: BrowserState | undefined;
        const displayed = () => candidate ?? current;

        const root = createView(RootType, {
            id: 'root', name: 'Root', render: () => ({ body: rootBody, context: { onFetch: fetchPage } }),
        });
        const search = createView(SearchType, {
            id: 'search', name: 'Search', render: () => ({ body: searchBody(displayed().search), context: { onSearch: searchWeb } }),
        });

        function show(next: BrowserState): void {
            const views = [root, search, ...(next.results ? [next.results] : []), ...(next.page ? [next.page.view] : [])];
            candidate = next;
            try {
                if (next.results && next.results !== current.results || next.page && next.page.view !== current.page?.view) {
                    const result = prepareOpeningProjection({ views });
                    if (result.status === 'rejected') {
                        throw Object.assign(new Error('The new browser View does not fit. Close the current Page or clear the results and try again.'), { code: result.issue.code });
                    }
                } else prepareProjection({ views });
                current = next;
            } finally { candidate = undefined; }
        }

        async function searchWeb(query: SearchQuery): Promise<{ resultCount: number }> {
            let response: Awaited<ReturnType<typeof runWebSearch>>;
            try { response = await runWebSearch(query); }
            catch (error) {
                show({ ...current, search: { status: 'error', query, error: (error as Error).message, results: [] }, results: undefined });
                throw error;
            }
            const { summary, results } = response;
            const view = results.length ? createView(ResultListType, {
                id: 'results', name: 'Result List',
                render: () => ({
                    body: resultListBody(results),
                    context: {
                        results,
                        onOpenResult: (url: string) => fetchPage({ url, format: 'markdown' }),
                        onClearResults: () => show({ ...current, search: { status: 'idle', results: [] }, results: undefined }),
                    },
                }),
            }) : undefined;
            show({ ...current, search: { status: 'success', query, results, summary }, results: view });
            return { resultCount: results.length };
        }

        function showPage(state: PageState): ViewHandle {
            const previous = current.page;
            const view = previous && previous.state.document?.url === state.document?.url ? previous.view : createView(PageType, {
                id: 'page', name: 'Page',
                render: () => ({
                    body: pageBody(displayed().page!.state),
                    context: { onClosePage: () => show({ ...current, page: undefined }) },
                }),
            });
            show({ ...current, page: { state, view } });
            return view;
        }

        async function fetchPage(params: { url: string; format?: FetchFormat; timeout?: number }): Promise<string> {
            let document: Awaited<ReturnType<typeof runWebFetch>>;
            try { document = await runWebFetch(params); }
            catch (error) {
                try { showPage({ status: 'error', error: (error as Error).message }); }
                catch { /* Preserve the fetch error. Runtime reports any projection fault. */ }
                throw error;
            }
            const view = showPage({ status: 'success', document });
            const id = readViewId(view);
            if (!id) throw new Error('The fetched Page is unavailable in the prepared projection.');
            return id;
        }

        prepareProjection({ views: [root, search] });
    },
});
