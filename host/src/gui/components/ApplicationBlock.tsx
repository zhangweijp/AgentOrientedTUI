/**
 * ApplicationBlock Component — macOS 26 Liquid Glass redesign
 *
 * Shows: app header (name / status) + view tabs (when >1 view) + active view content.
 * Removed: Recent activity, View Tree.
 *
 * @module system-chat/gui/components/ApplicationBlock
 */
import { useState } from 'react';
import type { TuiApplication } from './TuiParser.js';
import { getAppIcon } from './TuiParser.js';
import { ViewBlock } from './ViewBlock.js';

interface ApplicationBlockProps {
    app: TuiApplication;
}

export function ApplicationBlock({ app }: ApplicationBlockProps) {
    const [activeViewId, setActiveViewId] = useState<string | null>(null);
    const activeView = app.views.find(view => view.id === activeViewId) ?? app.views[0] ?? null;
    const appIcon = getAppIcon(app.name);
    const status = app.status ?? 'running';

    return (
        <div className="tui-app-card">
            {/* ── Card Header ── */}
            <div className="tui-app-card-header">
                <div className="tui-app-card-title">
                    <span className="tui-app-card-icon">{appIcon}</span>
                    <div className="tui-app-card-info">
                        <span className="tui-app-card-name">{app.name}</span>
                        <span className="tui-app-card-id">{app.id}</span>
                    </div>
                </div>
                <div className="tui-app-card-status">
                    {status === 'running' && <span className="breathing-dot" />}
                    <span className={`status-badge status-badge--${status}`}>{status.toUpperCase()}</span>
                </div>
            </div>

            {/* ── View Tabs (only when multiple views) ── */}
            {app.views.length > 1 && (
                <div className="tui-view-tabs">
                    <div className="tui-view-tabs-list">
                        {app.views.map(view => (
                            <button
                                key={view.id}
                                className={`tui-view-tab ${view.id === activeView?.id ? 'active' : ''}`}
                                onClick={() => setActiveViewId(view.id)}
                            >
                                <span className="tui-view-tab-name">{view.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Active View Content ── */}
            <div className="tui-app-card-content">
                {activeView ? (
                    <ViewBlock view={activeView} />
                ) : (
                    <div className="tui-no-view">No views available</div>
                )}
            </div>
        </div>
    );
}
