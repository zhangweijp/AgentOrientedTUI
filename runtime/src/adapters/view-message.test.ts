import { describe, expect, it } from 'vitest';
import { buildViewMessageMarkup } from './view-message.js';

describe('buildViewMessageMarkup', () => {
    it('wraps the supplied body once without interpreting literal View-like body text', () => {
        const body = '<view id="literal">body from file</view>';
        const message = buildViewMessageMarkup({
            appId: 'ide', appName: 'IDE', viewId: 'file', viewType: 'File', region: 'dynamic', markup: body,
        });

        expect(message).toBe('<view view_id="file" view_type="File" app_id="ide" app_name="IDE" region="dynamic">\n' +
            `&lt;view id="literal"&gt;body from file&lt;/view&gt;\n</view>`);
        expect(message.match(/<view\b/g)).toHaveLength(1);
        expect(message.match(/<\/view>/g)).toHaveLength(1);
        expect(message).not.toContain('bar">');
    });

    it('preserves leading and trailing body whitespace around the message envelope', () => {
        const body = '  first line\nlast line  \n';
        const message = buildViewMessageMarkup({ appId: 'app', appName: 'App', viewId: 'file', viewType: 'File', region: 'dynamic', markup: body });

        expect(message).toBe('<view view_id="file" view_type="File" app_id="app" app_name="App" region="dynamic">\n' +
            `${body}\n</view>`);
    });

    it('shows complete root addresses and escaping without including Ref values or Schema data', () => {
        const page: Parameters<typeof buildViewMessageMarkup>[0] = {
            appId: 'contacts', appName: 'Contacts', viewId: 'list', viewType: 'list', region: 'dynamic', markup: '# Contacts',
            refs: [
                { viewId: 'list', viewInstanceId: 'first', refId: 'teams', refType: 'Team', array: true, scope: 'public',
                    valueSchema: { type: 'array', items: { type: 'object' } } },
                { viewId: 'list', viewInstanceId: 'first', refId: 'private_value', refType: 'Value', scope: 'private',
                    valueSchema: { type: 'string', default: 'Do not render payload' } },
            ],
        };
        const markup = buildViewMessageMarkup(page);
        expect(markup.split('\n').filter(line => line.startsWith('- '))).toEqual([
            '- public $ref.contacts.list.teams (Team[])', '- private $ref.contacts.list.private_value (Value)',
        ]);
        expect(markup).not.toContain('Do not render payload');
    });
});


it('encodes envelope delimiters as XML text exactly once and preserves decoded body', async () => {
    const { JSDOM } = await import('jsdom');
    const window = new JSDOM().window;
    const body = '    code  \n```\n<view id="literal">&lt;x&gt;</view>\n</application>\nlast  \n';
    const message = buildViewMessageMarkup({ appId: 'app', appName: 'A & <B>', viewId: 'file', viewType: 'File', region: 'dynamic', markup: body });
    const document = new window.DOMParser().parseFromString(message, 'text/xml');
    expect(document.querySelectorAll('view')).toHaveLength(1);
    expect(document.documentElement.getAttributeNames()).toEqual(['view_id', 'view_type', 'app_id', 'app_name', 'region']);
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
        const markup = buildViewMessageMarkup({ appId: 'app', appName: 'App', viewId: 'file', viewType: 'File', region: 'dynamic', markup: body });
        const document = new window.DOMParser().parseFromString(markup, 'text/xml');
        expect(document.querySelector('parsererror')).toBeNull();
        expect(document.documentElement.textContent).toBe('\n' + body + '\n');
    } finally { window.close(); }
});

it('B4-T06 validates actual rendered XML fields, never changing legal Markdown or business data',async()=>{
    const {JSDOM}=await import('jsdom');
    const parser=new (new JSDOM().window.DOMParser)();
    const fields={appId:'app',appName:'App\t\n\r&"',viewId:'file',viewType:'File',region:'dynamic' as const};
    const body='\r\n\r\t\n~~~ts\n<view id="fake">&amp;</view> ]]> 日本語 😀\n~~~\n';
    const rendered=parser.parseFromString(buildViewMessageMarkup({...fields,markup:body}),'text/xml');
    expect(rendered.querySelector('parsererror')).toBeNull();
    expect(rendered.documentElement.textContent).toBe('\n'+body+'\n');
    expect(rendered.documentElement.getAttribute('app_name')).toBe(fields.appName);
    for(const value of ['\0','\u001f','\ud800','\udfff','\ufffe','\uffff']) {
        expect(()=>buildViewMessageMarkup({...fields,markup:'before'+value+'after'}))
            .toThrow(expect.objectContaining({code:'AOTUI_XML_UNSUPPORTED',path:'$.view.content',appId:'app',viewId:'file'}));
        expect(()=>buildViewMessageMarkup({...fields,appName:'bad'+value,markup:body}))
            .toThrow(expect.objectContaining({code:'AOTUI_XML_UNSUPPORTED',path:'$.view.attributes.app_name'}));
    }
    expect(()=>buildViewMessageMarkup({...fields,markup:body,refs:[{viewId:'file',viewInstanceId:'mount',refId:'value',
        refType:'bad\0type',scope:'public',valueSchema:{type:'string'}}]}))
        .toThrow(expect.objectContaining({code:'AOTUI_XML_UNSUPPORTED',path:'$.refs[0].refType'}));
});
