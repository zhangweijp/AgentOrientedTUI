import type { FetchDocument, FetchFormat } from '../types.js';

const MAX_BYTES = 5 * 1024 * 1024;

const buildAccept = (format: FetchFormat): string => {
    if (format === 'html') {
        return 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    }
    if (format === 'text') {
        return 'text/plain, text/html;q=0.7, application/xhtml+xml;q=0.7, */*;q=0.5';
    }
    return 'text/markdown, text/html;q=0.8, application/xhtml+xml;q=0.7, */*;q=0.5';
};

const ensureUrl = (value: string) => {
    if (!/^https?:\/\//i.test(value)) {
        throw new Error('URL must start with http:// or https://');
    }
};

const stripHtml = (html: string): string => {
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, '');
    const withoutTags = withoutStyles.replace(/<\/?[^>]+>/g, ' ');
    return withoutTags.replace(/\s+/g, ' ').trim();
};

async function readBody(response: Response, decodeText: boolean): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = decodeText ? new TextDecoder() : undefined;
    let size = 0;
    let text = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (value) size += value.byteLength;
            if (size > MAX_BYTES) break;
            if (decoder) {
                text += done ? decoder.decode() : decoder.decode(value, { stream: true });
                if (text.length * 2 > MAX_BYTES) break;
            }
            if (done) return text;
        }
        throw new Error('Response size exceeds 5MB limit');
    } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
}

const normalizeContentType = (value: string | null): string => value?.split(';')[0]?.trim() ?? '';

export const runWebFetch = async (params: {
    url: string;
    format?: FetchFormat;
    timeout?: number;
}): Promise<FetchDocument> => {
    ensureUrl(params.url);
    const format = params.format ?? 'markdown';
    const controller = new AbortController();
    const timeoutMs = Math.min((params.timeout ?? 30) * 1000, 120000);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(params.url, {
            method: 'GET',
            headers: {
                accept: buildAccept(format),
                'user-agent': 'AOTUI-LiteBrowser/1.0'
            },
            signal: controller.signal
        });

        let finalResponse = response;
        if (finalResponse.status === 403 && finalResponse.headers.get('cf-mitigated') === 'challenge') {
            finalResponse = await fetch(params.url, {
                method: 'GET',
                headers: {
                    accept: buildAccept(format),
                    'user-agent': 'opencode'
                },
                signal: controller.signal
            });
        }

        if (!finalResponse.ok) {
            const errorText = await readBody(finalResponse, true);
            throw new Error(`Fetch failed: ${finalResponse.status} ${errorText}`);
        }

        const contentType = normalizeContentType(finalResponse.headers.get('content-type'));
        const isImage = contentType.startsWith('image/') && !contentType.includes('svg');
        const body = await readBody(finalResponse, !isImage);
        const content = isImage ? 'Image fetched successfully'
            : format !== 'html' && contentType.includes('html') ? stripHtml(body) : body;
        return { url: params.url, contentType, format, content };
    } finally {
        clearTimeout(timeoutId);
    }
};
