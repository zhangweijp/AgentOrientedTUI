export type SearchQuery = {
    query: string;
    numResults?: number;
    livecrawl?: 'fallback' | 'preferred';
    type?: 'auto' | 'fast' | 'deep';
    contextMaxCharacters?: number;
};

export type SearchResultItem = {
    title: string;
    url: string;
    snippet: string;
};

export type SearchState = {
    status: 'idle' | 'success' | 'error';
    error?: string;
    query?: SearchQuery;
    summary?: string;
};

export type FetchFormat = 'text' | 'markdown' | 'html';

export type FetchDocument = {
    url: string;
    contentType: string;
    format: FetchFormat;
    content: string;
};

export type PageState = {
    status: 'success' | 'error';
    error?: string;
    document?: FetchDocument;
};
