import { FetchToolSection, type BrowserActions } from './BrowserTools.js';

export function RootView({ onFetch }: Pick<BrowserActions, 'onFetch'>) {
    return <>
        <section data-role="application-instruction">
            <h1>Lite Browser Application Instruction</h1>
            <p>Search runs a query. ResultList contains the current results and their open/clear tools.</p>
            <p>Fetch a URL here to open Page. Page shows fetched content and exposes its own close action.</p>
            <p>Tool receipts describe the operation. Read search results and page content from their current Views.</p>
        </section>
        <FetchToolSection onFetch={onFetch} />
    </>;
}
