import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readSemanticDesktopSnapshot } from '../../src/core/semantic-desktop-snapshot.js';
import { parseTuiSnapshot } from '../../src/gui/components/TuiParser.js';
import { TuiDesktopViewer } from '../../src/gui/components/TuiDesktopViewer.js';

afterEach(cleanup);
function fixture() {
    const apps = [
        { appId: 'app_0', name: 'system_ide', status: 'running' },
        { appId: 'app_1', name: 'terminal', status: 'running' },
        { appId: 'app_2', name: 'lite_browser', status: 'pending' },
    ];
    const view = (id: string, name: string, body: string) => ({ id, viewInstanceId: id + '-instance', type: name, name,
        kind: id === 'root' ? 'instruction' : 'state', content: { format: 'markdown-v1', value: `<view id="${id}">\n${body}\n</view>` } });
    const views = new Map([
        ['app_0', [view('root', 'Root', 'IDE instructions'), view('workspace', 'Workspace', 'Workspace folders')]],
        ['app_1', [view('root', 'Root', 'Terminal instructions'), view('term_console', 'TerminalConsole', 'Terminal sessions')]],
        ['app_2', [view('root', 'Root', 'Browser instructions')]],
    ]);
    const clients: any[] = [];
    const forbidden = vi.fn(() => { throw new Error('LEGACY_INTERACTION_USED'); });
    const desktop = { id: 'preview', getInstalledApps: () => apps, getSystemLogs: () => [], getSnapshotFragments: forbidden };
    const kernel = { acquireSnapshot: forbidden, execute: forbidden,
        experimentalCreateAppScope: vi.fn((_desktop: string, appId: string) => {
            const client = { observe: vi.fn(async () => ({ status: 'observed', observation: {
                observationId: appId + '-observation', expiresAt: null,
                source: { appId, instanceId: 'run', snapshotId: 'snapshot', revision: 1 },
                views: views.get(appId) ?? [], refs: [], tools: [], bindings: [],
            } })), releaseObservation: vi.fn(), close: vi.fn() };
            clients.push(client); return { status: 'opened', client };
        }),
    };
    return { apps, views, view, clients, forbidden, async preview() {
        return (await readSemanticDesktopSnapshot(desktop as any, kernel as any)).markup;
    } };
}

describe('Semantic Desktop preview → GUI', () => {
    it('groups Semantic messages into the GUI application contract and releases observations', async () => {
        const f = fixture(), markup = await f.preview(), parsed = parseTuiSnapshot(markup);
        expect(parsed.parseErrors).toEqual([]);
        expect(parsed.desktop?.applications.map(app => app.name)).toEqual(['system_ide', 'terminal', 'lite_browser']);
        expect(parsed.desktop?.applications.map(app => app.views.map(view => view.id))).toEqual([['root', 'workspace'], ['root', 'term_console'], []]);
        expect(parsed.desktop?.applications[0].views[0].content).toBe('IDE instructions');
        expect(parsed.desktop?.applications[1].views[0].content).toBe('Terminal instructions');
        expect(markup.indexOf('<desktop>')).toBeLessThan(markup.indexOf('<application '));
        for (const client of f.clients) {
            expect(client.releaseObservation).toHaveBeenCalledOnce(); expect(client.close).toHaveBeenCalledOnce();
        }
        expect(f.forbidden).not.toHaveBeenCalled();
    });
    it('renders the application switcher and each application’s own Root View', async () => {
        const f = fixture(); render(<TuiDesktopViewer snapshot={await f.preview()} />);
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
        const ui = render(<TuiDesktopViewer snapshot={await f.preview()} />);
        fireEvent.click(screen.getByRole('button', { name: 'demo.ts' }));
        expect(screen.getByText('file version one')).toBeInTheDocument();
        f.views.get('app_0')![2] = f.view('fd_1', 'demo.ts', 'file version two');
        ui.rerender(<TuiDesktopViewer snapshot={await f.preview()} />);
        expect(screen.queryByText('file version one')).toBeNull(); expect(screen.getByText('file version two')).toBeInTheDocument();
        f.views.get('app_0')!.pop(); ui.rerender(<TuiDesktopViewer snapshot={await f.preview()} />);
        expect(screen.queryByText('No views available')).toBeNull(); expect(screen.getByText('IDE instructions')).toBeInTheDocument();
    });
    it('preserves the selected View by identity when a sibling disappears', async () => {
        const f = fixture(); f.views.get('app_0')!.push(f.view('fd_1', 'demo.ts', 'selected file'));
        const ui = render(<TuiDesktopViewer snapshot={await f.preview()} />);
        fireEvent.click(screen.getByRole('button', { name: 'demo.ts' }));
        f.views.get('app_0')!.splice(1, 1); ui.rerender(<TuiDesktopViewer snapshot={await f.preview()} />);
        expect(screen.getByText('selected file')).toBeInTheDocument();
    });
    it('represents pending and closed apps without claiming they are running', async () => {
        const f = fixture(), ui = render(<TuiDesktopViewer snapshot={await f.preview()} />);
        fireEvent.click(screen.getByRole('button', { name: 'lite_browser' }));
        expect(screen.getByText('PENDING')).toBeInTheDocument(); expect(screen.queryByText('RUNNING')).toBeNull();
        f.apps[2].status = 'running'; ui.rerender(<TuiDesktopViewer snapshot={await f.preview()} />);
        expect(screen.getByText('Browser instructions')).toBeInTheDocument(); expect(screen.getByText('RUNNING')).toBeInTheDocument();
        f.apps[2].status = 'closed'; ui.rerender(<TuiDesktopViewer snapshot={await f.preview()} />);
        expect(screen.getByText('CLOSED')).toBeInTheDocument(); expect(screen.queryByText('Browser instructions')).toBeNull();
    });
    it('keeps an installed app discoverable when it has no Views', async () => {
        const f = fixture(); f.views.set('app_0', []); render(<TuiDesktopViewer snapshot={await f.preview()} />);
        expect(screen.getByRole('button', { name: 'system_ide' })).toBeInTheDocument();
        expect(screen.getByText('No views available')).toBeInTheDocument(); expect(screen.queryByText('No applications found.')).toBeNull();
    });
    it('round trips escaped application and View names', async () => {
        const f = fixture(); f.apps[0].name = 'IDE & "Notes"'; f.views.set('app_0', [f.view('root', 'A & "B"', 'Text remains unchanged')]);
        const app = parseTuiSnapshot(await f.preview()).desktop!.applications[0];
        expect(app.name).toBe('IDE & "Notes"'); expect(app.views[0].name).toBe('A & "B"'); expect(app.views[0].content).toBe('Text remains unchanged');
    });
    it('shows the empty state for an actually empty Desktop', async () => {
        const f = fixture(); f.apps.length = 0; render(<TuiDesktopViewer snapshot={await f.preview()} />);
        expect(screen.getByText('No applications found.')).toBeInTheDocument(); expect(f.clients).toHaveLength(0);
    });
    it('retains support for the existing grouped snapshot format', () => {
        const parsed = parseTuiSnapshot('<desktop>Desktop content</desktop>\n<application id="app_0" name="old_app"><application_info>Info</application_info><view id="root" name="Root">Existing content</view></application>');
        expect(parsed.desktop?.applications[0]).toMatchObject({ id: 'app_0', name: 'old_app', infoContent: 'Info', views: [{ id: 'root', name: 'Root', content: 'Existing content' }] });
    });
});
