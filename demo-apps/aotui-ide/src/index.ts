export { default } from './scoped.js';
export { default as SystemIDEApp } from './scoped.js';
/** Resolve exactly one factory before starting an App; never mount both routes. */
export function ideEntryForRoute(route: 'legacy' | 'scoped' = 'scoped'): URL {
    if (route !== 'legacy' && route !== 'scoped') throw new Error('IDE_ROUTE_INVALID');
    return new URL(route === 'legacy' ? './tui/index.js' : './scoped.js', import.meta.url);
}
