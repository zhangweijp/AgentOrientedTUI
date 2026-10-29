import type { SearchResultItem } from '../types.js';

type ResultListViewProps = {
    results: SearchResultItem[];
};

export function ResultListView({ results }: ResultListViewProps) {
    return (
        <div>
            <h2>Search Results</h2>
            <p>Total: {results.length}</p>
            {results.length > 0 ? (
                <ul>
                    {results.map(result => (
                        <li key={result.id}>
                            <p>{result.title || result.url}</p>
                            <p>{result.url}</p>
                            {result.snippet ? <p>{result.snippet}</p> : null}
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
