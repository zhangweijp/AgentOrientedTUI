import { FetchToolSection, type BrowserActions } from './BrowserTools.js';

export function RootView({ onFetch }: Pick<BrowserActions, 'onFetch'>) {
    return <>
        <section data-role="application-instruction">
            <h1>Lite Browser - Application Instruction</h1>
            <h2>What it is</h2><p>A lightweight TUI browser that searches the web and fetches page content into structured Views.</p>
            <h2>How to use</h2><ol>
                <li>Use Search to run a query, then inspect the ResultList's titles, URLs and snippets.</li>
                <li>Use open_result on the current result list to open a listed URL, or fetch_url on Root to fetch a URL directly.</li>
                <li>Read the resulting Page. Close it or clear obsolete search results when finished.</li>
            </ol>
            <h2>Views</h2>
            <h3>Root</h3><p>Contains these instructions and fetch_url. Supply a URL; optional format and timeout control fetching. Use it again to fetch updated page content.</p>
            <h4>Available Tools</h4><ul><li>fetch_url</li></ul>
            <h3>Search</h3><p>Shows search status. search_web requires a non-empty query; optional parameters refine result count and crawl mode.</p>
            <h4>Available Tools</h4><ul><li>search_web</li></ul>
            <h3>ResultList</h3><p>Shows current search results. open_result requires a URL from this list. clear_results removes the list and its tools.</p>
            <h4>Available Tools</h4><ul><li>open_result</li><li>clear_results</li></ul>
            <h3>Page</h3><p>Shows fetched content and extracted attachments. close_page is available while this Page is open and removes its View and tools.</p>
            <h4>Available Tools</h4><ul><li>close_page</li></ul>
            <h4>Tool Preconditions</h4><p>Use a non-empty search query, a valid URL for fetching, and a URL from the current results for open_result. Result and Page actions require their respective Views to remain open.</p>
            <p>Available Tools is a static catalog by View Type. Only tools attached to the current context are callable; ResultList and Page tools require their Views to be open.</p>
            <p>Tool receipts describe the operation. Read search results and page content from their current Views.</p>
        </section>
        <FetchToolSection onFetch={onFetch} />
    </>;
}
