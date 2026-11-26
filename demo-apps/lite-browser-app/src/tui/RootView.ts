export const rootBody = `# Lite Browser - Application Instruction

## What it is

A lightweight TUI browser that searches the web and fetches page content into structured Views.

## How to use

1. Use Search to run a query, then inspect the ResultList's titles, URLs and snippets.
2. Use open_result to open a listed URL, or fetch_url on Root to fetch a URL directly.
3. Read the resulting Page. Close it or clear obsolete search results when finished.

## Views

### Root

These instructions and fetch_url. Supply a URL; optional format and timeout control fetching. Use it again to fetch updated content.

### Search

Search status. search_web requires a non-empty query. Optional parameters refine result count and crawl mode.

### ResultList

Current search results. open_result requires a URL from the list. clear_results removes the list and its tools.

### Page

Fetched content and extracted attachments. close_page removes the current Page and its tools.

Browser tools operate on their single current View. Pass the business parameters declared in the tool schema. Read search results and page content in the current Views.
`;
