import { describe, expect, it } from 'vitest';
import type { Observation, RefConsumer } from '@aotui/core';
import { buildViewMessageMarkup } from './view-message.js';

describe('buildViewMessageMarkup', () => {
    it('wraps the supplied body once without interpreting literal View-like body text', () => {
        const body = '<view id="literal">body from file</view>';
        const message = buildViewMessageMarkup({
            appId: 'ide', appName: 'IDE', viewId: 'file', viewType: 'File', markup: body,
        });

        expect(message).toBe('<view view_id="file" view_type="File" app_id="ide" app_name="IDE">\n' +
            `&lt;view id="literal"&gt;body from file&lt;/view&gt;\n</view>`);
        expect(message.match(/<view\b/g)).toHaveLength(1);
        expect(message.match(/<\/view>/g)).toHaveLength(1);
        expect(message).not.toContain('bar">');
    });

    it('preserves leading and trailing body whitespace around the message envelope', () => {
        const body = '  first line\nlast line  \n';
        const message = buildViewMessageMarkup({ appId: 'app', appName: 'App', viewId: 'file', viewType: 'File', markup: body });

        expect(message).toBe('<view view_id="file" view_type="File" app_id="app" app_name="App">\n' +
            `${body}\n</view>`);
    });

    it('renders each path only for its presented recipient and retains unscoped hints', () => {
        const primary = { appId: 'mail', instanceId: 'mail-instance', viewId: 'draft', viewInstanceId: 'first-mount' };
        const secondary = { appId: 'mail_1', instanceId: 'mail_1-instance', viewId: 'draft', viewInstanceId: 'second-mount' };
        const target = (consumer: RefConsumer): Pick<Observation, 'source' | 'views'> => ({
            source: { appId: consumer.appId, instanceId: consumer.instanceId, snapshotId: 'snapshot', revision: 1 },
            views: [{ id: consumer.viewId, viewInstanceId: consumer.viewInstanceId, type: 'draft', name: 'Draft',
                region: 'dynamic', content: { format: 'markdown-v1', value: '# Draft' } }],
        });
        const publisher = { viewId: 'list', viewInstanceId: 'list-mount', kind: 'snapshot-value', scope: 'public' } as const;
        const page: Parameters<typeof buildViewMessageMarkup>[0] = {
            appId: 'contacts', appName: 'Contacts', viewId: 'list', viewType: 'list', markup: '# Contacts',
            refs: [{ ...publisher, refId: 'teams', refType: 'Team', array: true }, {
                ...publisher, refId: 'people', paths: [
                    { path: [0, 'email'], consumer: primary, valueType: 'string' },
                    { path: [0, 'phone'], consumer: secondary, valueType: 'string' },
                    { path: [0, 'name'], valueType: 'string' },
                ],
            }],
        };
        const hints = (markup: string) => markup.split('\n').filter(line => line.startsWith('- '));
        const whole = '- public teams: Team[]';
        const unscoped = '- public $contacts.list.people[0].name (string)';
        const email = '- public $contacts.list.people[0].email (string) for app_id mail, view_id draft';
        const phone = '- public $contacts.list.people[0].phone (string) for app_id mail_1, view_id draft';

        expect(hints(buildViewMessageMarkup(page))).toEqual([whole, unscoped]);
        const presented = new Map([[primary.appId, target(primary)]]);
        expect(hints(buildViewMessageMarkup(page, presented))).toEqual([whole, email, unscoped]);
        presented.set(secondary.appId, target(secondary));
        expect(hints(buildViewMessageMarkup(page, presented))).toEqual([whole, email, phone, unscoped]);
        for (const mismatch of [{ appId: 'different-app' }, { instanceId: 'different-run' },
            { viewId: 'different-page' }, { viewInstanceId: 'new-mount' }]) {
            presented.set(secondary.appId, target({ ...secondary, ...mismatch }));
            expect(hints(buildViewMessageMarkup(page, presented))).toEqual([whole, email, unscoped]);
        }
    });
});


it('encodes envelope delimiters as XML text exactly once and preserves decoded body', async () => {
    const { JSDOM } = await import('jsdom');
    const window = new JSDOM().window;
    const body = '    code  \n```\n<view id="literal">&lt;x&gt;</view>\n</application>\nlast  \n';
    const message = buildViewMessageMarkup({ appId: 'app', appName: 'A & <B>', viewId: 'file', viewType: 'File', markup: body });
    const document = new window.DOMParser().parseFromString(message, 'text/xml');
    expect(document.querySelectorAll('view')).toHaveLength(1);
    expect(document.documentElement.getAttributeNames()).toEqual(['view_id', 'view_type', 'app_id', 'app_name']);
    expect(document.documentElement.getAttribute('app_name')).toBe('A & <B>');
    expect(document.documentElement.textContent).toBe('\n' + body + '\n');
    expect(message).toContain('&lt;view id="literal"&gt;&amp;lt;x&amp;gt;&lt;/view&gt;');
    window.close();
});


it.each([
    ['LF', '    first\nsecond  \n'],
    ['CRLF', '    first\r\nsecond  \r\n'],
    ['independent CR', '    first\rsecond  \r'],
])('preserves %s in normal XML consumption', async (_name, body) => {
    const { JSDOM } = await import('jsdom');
    const window = new JSDOM().window;
    try {
        const markup = buildViewMessageMarkup({ appId: 'app', appName: 'App', viewId: 'file', viewType: 'File', markup: body });
        const document = new window.DOMParser().parseFromString(markup, 'text/xml');
        expect(document.querySelector('parsererror')).toBeNull();
        expect(document.documentElement.textContent).toBe('\n' + body + '\n');
    } finally { window.close(); }
});
