/** Format shared Desktop presentation values used by Semantic observation output. */
export function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toISOString().replace('T', ' ').slice(0, 19);
}

export function formatAppStatus(status: 'pending' | 'running' | 'paused' | 'closed' | 'collapsed'): string {
    switch (status) {
        case 'running': return 'running';
        case 'paused': return 'paused';
        case 'pending': return 'available (not started)';
        case 'closed': return 'not launched';
        case 'collapsed': return 'minimized';
        default: return status;
    }
}
