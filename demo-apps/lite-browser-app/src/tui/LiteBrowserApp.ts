import pkg from '../../package.json' with { type: 'json' };
import { createApp, createView, type ViewHandle } from '@aotui/sdk';
import { runWebFetch } from '../core/webfetch.js';
import { runWebSearch } from '../core/websearch.js';
import type { FetchFormat, PageState, SearchQuery, SearchState, SearchResultItem } from '../types.js';
import { pageBody } from './PageView.js';
import { resultListBody } from './ResultListView.js';
import { rootBody } from './RootView.js';
import { searchBody } from './SearchView.js';
import { RootType, SearchType, ResultListType, PageType, browserViewTypes } from './BrowserTools.js';

export default createApp({
    ...pkg.aotui,
    viewTypes: browserViewTypes,
    initialize({ publish, readViewId }) {
        type BrowserState = { search: SearchState; results?: {view: ViewHandle<typeof ResultListType>; items: readonly SearchResultItem[]};
            page?: { state: PageState; view: ViewHandle<typeof PageType> } };
        let current: BrowserState = { search: { status: 'idle' } };
        const root = createView(RootType, { id: 'root' });
        const search = createView(SearchType, { id: 'search' });

        function frames(next: BrowserState) {
            return [
                root.frame({name: 'Root', body: rootBody, context: { onFetch: fetchPage }}),
                search.frame({name: 'Search', body: searchBody(next.search), context: { onSearch: searchWeb }}),
                ...(next.results ? [next.results.view.frame({name: 'Result List', body: resultListBody(next.results.items),
                    context: { results: next.results.items,
                        onOpenResult: (url: string) => fetchPage({ url, format: 'markdown' }),
                        onClearResults: () => show({ ...current, search: { status: 'idle' }, results: undefined }),
                    } })] : []),
                ...(next.page ? [next.page.view.frame({name: 'Page', body: pageBody(next.page.state),
                    bindingKey: next.page.state.document?.url,
                    context: { onClosePage: () => show({ ...current, page: undefined }) } })] : []),
            ];
        }
        function show(next: BrowserState): void {
            const result = publish(() => frames(next), {mode:'candidate'});
            if (!result.ok) throw Object.assign(new Error('The browser View could not be prepared.'), {code: result.issue.code});
            current = next;
        }

        async function searchWeb(query: SearchQuery): Promise<{ resultCount: number }> {
            let response: Awaited<ReturnType<typeof runWebSearch>>;
            try { response = await runWebSearch(query); }
            catch (error) {
                show({ ...current, search: { status: 'error', query, error: (error as Error).message }, results: undefined });
                throw error;
            }
            const { summary, results } = response;
            const view = results.length ? createView(ResultListType, {id: 'results'}) : undefined;
            show({ ...current, search: { status: 'success', query, summary }, results: view ? {view, items: results} : undefined });
            return { resultCount: results.length };
        }

        function showPage(state: PageState): ViewHandle {
            const previous = current.page;
            const view = previous && previous.state.document?.url === state.document?.url ? previous.view :
                createView(PageType, { id: 'page' });
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

        publish(() => frames(current));
    },
});
