import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readDesktopPreview } from '../../src/core/desktop-preview.js';
import { TuiDesktopViewer } from '../../src/gui/components/TuiDesktopViewer.js';

afterEach(cleanup);
function fixture() {
    const apps = [
        { installationId: 'workspace', appId: 'app_0', appInstanceId: 'app_0-run', name: 'system_ide', status: 'running' },
        { installationId: 'shell', appId: 'app_1', appInstanceId: 'app_1-run', name: 'terminal', status: 'running' },
        { installationId: 'browser', appId: 'app_2', appInstanceId: 'app_2-run', name: 'lite_browser', status: 'pending' },
    ];
    const view = (id: string, name: string, body: string) => ({ toolBindings: [], id, viewInstanceId: id + '-instance', type: name, name,
        region: id === 'root' ? 'static' : 'dynamic', content: { format: 'markdown-v1', value: body } });
    const views = new Map([
        ['app_0', [view('root', 'Root', 'IDE instructions'), view('workspace', 'Workspace', 'Workspace folders')]],
        ['app_1', [view('root', 'Root', 'Terminal instructions'), view('term_console', 'TerminalConsole', 'Terminal sessions')]],
        ['app_2', [view('root', 'Root', 'Browser instructions')]],
    ]);
    const clients: any[] = [];
    const forbidden = vi.fn(() => { throw new Error('PREVIEW_MUST_NOT_ADOPT_OR_INVOKE'); });
    const desktop = { id: 'preview', listApps: () => apps,
        getRunningApp: vi.fn((appId: string, instanceId: string) => {
            const client = { preview: vi.fn(async () => ({ status: 'previewed', source: { appId, instanceId, snapshotId: 'snapshot', revision: 1 },
                views: views.get(appId) ?? [] })), observe: forbidden };
            clients.push(client); return { status: 'ready', app: client };
        }),
    };
    return { apps, views, view, clients, forbidden, desktop, preview: () => readDesktopPreview(desktop as any) };
}

describe('Semantic Desktop preview → GUI', () => {
    it('explains installed but disabled applications without hiding them from inspection', async () => {
        const f = fixture();
        const apps = { enabled: true, items: f.apps.map(app => ({ name: app.installationId, enabled: app.installationId === 'shell' })) };
        const ui = render(<TuiDesktopViewer preview={await f.preview()} apps={apps} />);
        expect(screen.getByText(/1 enabled for this topic/)).toBeInTheDocument();
        expect(screen.getByText(/system_ide is not enabled for this topic/)).toBeInTheDocument();
        expect(screen.getByText('IDE instructions')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'terminal' }));
        expect(screen.queryByText(/is not enabled for this topic/)).toBeNull();
        ui.rerender(<TuiDesktopViewer preview={await f.preview()} apps={{ ...apps, enabled: false }} />);
        expect(screen.getByText(/0 enabled for this topic/)).toBeInTheDocument();
        expect(screen.getByText(/terminal is not enabled for this topic/)).toBeInTheDocument();
    });
    it('groups read-only previews into the GUI application contract without observations', async () => {
        const f = fixture(), { applications, diagnostics } = await f.preview();
        expect(diagnostics).toEqual([]);
        expect(applications.map(app => app.installationId)).toEqual(['workspace', 'shell', 'browser']);
        expect(applications.map(app => app.name)).toEqual(['system_ide', 'terminal', 'lite_browser']);
        expect(applications.map(app => app.views.map(view => view.id))).toEqual([['root', 'workspace'], ['root', 'term_console'], []]);
        expect(applications[0].views[0].content).toBe('IDE instructions');
        expect(applications[1].views[0].content).toBe('Terminal instructions');
        for (const client of f.clients) {
            expect(client.preview).toHaveBeenCalledOnce();
        }
        expect(f.forbidden).not.toHaveBeenCalled();
    });
    it('renders the application switcher and each application’s own Root View', async () => {
        const f = fixture(); render(<TuiDesktopViewer preview={await f.preview()} />);
        expect(screen.queryByText('No applications found.')).toBeNull();
        expect(screen.getByText('IDE instructions')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'terminal' }));
        expect(screen.getByText('Terminal instructions')).toBeInTheDocument();
        expect(screen.queryByText('IDE instructions')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'TerminalConsole' }));
        expect(screen.getByText('Terminal sessions')).toBeInTheDocument();
    });
    it('shows the latest file body and selects an existing View when the active file closes', async () => {
        const f = fixture(); f.views.get('app_0')!.push(f.view('fd_1', 'demo.ts', 'file version one'));
        const ui = render(<TuiDesktopViewer preview={await f.preview()} />);
        fireEvent.click(screen.getByRole('button', { name: 'demo.ts' }));
        expect(screen.getByText('file version one')).toBeInTheDocument();
        f.views.get('app_0')![2] = f.view('fd_1', 'demo.ts', 'file version two');
        ui.rerender(<TuiDesktopViewer preview={await f.preview()} />);
        expect(screen.queryByText('file version one')).toBeNull(); expect(screen.getByText('file version two')).toBeInTheDocument();
        f.views.get('app_0')!.pop(); ui.rerender(<TuiDesktopViewer preview={await f.preview()} />);
        expect(screen.queryByText('No views available')).toBeNull(); expect(screen.getByText('IDE instructions')).toBeInTheDocument();
    });
    it('preserves the selected View by identity when a sibling disappears', async () => {
        const f = fixture(); f.views.get('app_0')!.push(f.view('fd_1', 'demo.ts', 'selected file'));
        const ui = render(<TuiDesktopViewer preview={await f.preview()} />);
        fireEvent.click(screen.getByRole('button', { name: 'demo.ts' }));
        f.views.get('app_0')!.splice(1, 1); ui.rerender(<TuiDesktopViewer preview={await f.preview()} />);
        expect(screen.getByText('selected file')).toBeInTheDocument();
    });
    it('represents pending and closed apps without claiming they are running', async () => {
        const f = fixture(), ui = render(<TuiDesktopViewer preview={await f.preview()} />);
        fireEvent.click(screen.getByRole('button', { name: 'lite_browser' }));
        expect(screen.getByText('PENDING')).toBeInTheDocument(); expect(screen.queryByText('RUNNING')).toBeNull();
        f.apps[2].status = 'running'; ui.rerender(<TuiDesktopViewer preview={await f.preview()} />);
        expect(screen.getByText('Browser instructions')).toBeInTheDocument(); expect(screen.getByText('RUNNING')).toBeInTheDocument();
        f.apps[2].status = 'closed'; ui.rerender(<TuiDesktopViewer preview={await f.preview()} />);
        expect(screen.getByText('CLOSED')).toBeInTheDocument(); expect(screen.queryByText('Browser instructions')).toBeNull();
    });
    it('keeps an installed app discoverable when it has no Views', async () => {
        const f = fixture(); f.views.set('app_0', []); render(<TuiDesktopViewer preview={await f.preview()} />);
        expect(screen.getByRole('button', { name: 'system_ide' })).toBeInTheDocument();
        expect(screen.getByText('No views available')).toBeInTheDocument(); expect(screen.queryByText('No applications found.')).toBeNull();
    });
    it('preserves application and View names as literal text', async () => {
        const f = fixture(); f.apps[0].name = 'IDE & "Notes"'; f.views.set('app_0', [f.view('root', 'A & "B"', 'Text remains unchanged')]);
        const app = (await f.preview()).applications[0];
        expect(app.name).toBe('IDE & "Notes"'); expect(app.views[0].name).toBe('A & "B"'); expect(app.views[0].content).toBe('Text remains unchanged');
    });
    it('preserves body whitespace and literal delimiters without creating extra GUI Views', async () => {
        const f = fixture();
        const body = '    first  \n```\n<view id="literal">&lt;code&gt;</view>\n</application>\nlast  \n';
        f.views.set('app_0', [f.view('file', 'A > "B"', body)]);
        const app = (await f.preview()).applications[0];
        expect(app.views).toEqual([{ id: 'file', name: 'A > "B"', content: body }]);
    });
    it.each([
        ['CRLF', '    first\r\n<view id="literal">&lt;raw&gt;</view>\r\nlast  \r\n'],
        ['independent CR', '    first\r<view id="literal">&lt;raw&gt;</view>\rlast  \r'],
    ])('preserves %s body through the real preview callback', async (_name, body) => {
        const f = fixture();
        f.views.set('app_0', [f.view('file', 'A > "B"', body)]);
        const app = (await f.preview()).applications[0];
        expect(app.views).toEqual([{ id: 'file', name: 'A > "B"', content: body }]);
        for (const client of f.clients) {
            expect(client.preview).toHaveBeenCalledOnce();
        }
    });
    it('shows the empty state for an actually empty Desktop' , async () => {
        const f = fixture(); f.apps.length = 0; render(<TuiDesktopViewer preview={await f.preview()} />);
        expect(screen.getByText('No applications found.')).toBeInTheDocument(); expect(f.clients).toHaveLength(0);
    });
    it('reports an App projection fault alongside healthy applications', async () => {
        const f = fixture();
        f.desktop.getRunningApp.mockReturnValueOnce({
            status: 'rejected', issue: { code: 'SNAPSHOT_INVALID', message: 'Broken projection', path: '$.views' },
        } as any);
        const { applications, diagnostics } = await f.preview();
        expect(applications[0].views).toEqual([]);
        expect(diagnostics).toEqual(['system_ide: SNAPSHOT_INVALID: Broken projection (at $.views)']);
        render(<TuiDesktopViewer preview={{ applications, diagnostics }} />);
        expect(screen.getByText(/SNAPSHOT_INVALID/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'terminal' }));
        expect(screen.getByText('Terminal instructions')).toBeInTheDocument();
    });
});
