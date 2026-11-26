/** Format shared Desktop presentation values used by Semantic observation output. */
export function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toISOString().replace('T', ' ').slice(0, 19);
}
