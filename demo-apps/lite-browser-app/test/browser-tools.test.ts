import { describe, expect, it, vi } from 'vitest';
import { createOpenResultBinding } from '../src/tui/BrowserTools.js';
import { ResultListView } from '../src/tui/ResultListView.js';
import type { SearchResultItem } from '../src/types.js';

const result = (url: string): SearchResultItem => ({
    id: url,
    title: url,
    url,
    snippet: '',
    rank: 1,
});

describe('open_result app handler', () => {
    it('shows the URL value the Agent must pass to open_result', () => {
        const url = 'https://example.test/current';
        expect(JSON.stringify(ResultListView({ results: [result(url)] }))).toContain(url);
    });

    it('opens the selected result URL from the current result list', async () => {
        const onOpenResult = vi.fn(async (url: string) => `page:${url}`);
        const tool = createOpenResultBinding([result('https://example.test/a'), result('https://example.test/b')], onOpenResult);

        const receipt = await tool.execute({ url: 'https://example.test/b' });

        expect(onOpenResult).toHaveBeenCalledTimes(1);
        expect(onOpenResult).toHaveBeenCalledWith('https://example.test/b');
        expect(receipt).toMatchObject({ success: true, data: { view_id: 'page:https://example.test/b' } });
    });

    it('rejects a URL that is no longer part of the current results', async () => {
        const onOpenResult = vi.fn(async (url: string) => `page:${url}`);
        const tool = createOpenResultBinding([result('https://example.test/current')], onOpenResult);

        const receipt = await tool.execute({ url: 'https://example.test/old' });

        expect(onOpenResult).not.toHaveBeenCalled();
        expect(receipt).toMatchObject({ success: false, error: { code: 'RESULT_UNAVAILABLE' } });
    });
});
