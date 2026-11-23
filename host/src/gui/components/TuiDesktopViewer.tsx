/**
 * TuiDesktopViewer Component — macOS 26 Liquid Glass redesign
 *
 * Shows only: Current App switcher + Views per app.
 * Layout mirrors ChatArea: content starts below the context pill (pt-[78px])
 * and scrolls under it, preserving the floating-glass feel.
 *
 * @module system-chat/gui/components/TuiDesktopViewer
 */
import { useEffect, useState } from 'react';
import type { DesktopPreview } from '../../core/desktop-preview.js';
import { ApplicationBlock } from './ApplicationBlock.js';

interface TuiDesktopViewerProps {
    preview: DesktopPreview | undefined;
    agentThinking?: string;
    apps?: { enabled: boolean; items: Array<{ name: string; enabled: boolean }> };
}

export function TuiDesktopViewer({ preview, agentThinking, apps }: TuiDesktopViewerProps) {
    const applications = preview?.applications ?? [];
    const [activeAppId, setActiveAppId] = useState<string | null>(null);

    useEffect(() => {
        if (applications.length === 0) { setActiveAppId(null); return; }
        const stillExists = activeAppId && applications.some(app => app.installationId === activeAppId);
        if (stillExists) return;
        setActiveAppId(applications[0].installationId);
    }, [applications, activeAppId]);

    /* ── Empty / error state ── */
    if (!preview) {
        return (
            <div className="absolute inset-0 overflow-y-auto pt-[78px] px-6 pb-6 custom-scrollbar">
                <div className="flex flex-col items-center justify-center min-h-[200px]
                                text-[var(--color-text-tertiary)]">
                    <span className="text-3xl mb-3">📡</span>
                    <p className="text-[13px]">Waiting for the Desktop preview…</p>
                </div>
            </div>
        );
    }

    const activeApp = applications.find(app => app.installationId === activeAppId) ?? applications[0] ?? null;

    return (
        /* Mirrors ChatArea layout: absolute inset-0 + pt-[78px] so first content clears
           the context pill, and the pill floats on top as content scrolls under it. */
        <div className="absolute inset-0 overflow-y-auto pt-[78px] px-6 pb-6
                        custom-scrollbar space-y-4">

            {apps && (
                <p className="text-[13px] text-[var(--color-text-tertiary)]">
                    Installed applications preview. {apps.enabled ? apps.items.filter(app => app.enabled).length : 0} enabled for this topic.
                    {activeApp && !(apps.enabled && apps.items.some(app => app.name === activeApp.installationId && app.enabled)) && (
                        <span> {activeApp.name} is not enabled for this topic; its Views and Tools are not sent to the Agent. Change this in Chat → Apps.</span>
                    )}
                </p>
            )}

            {preview.diagnostics.length > 0 && (
                <ul className="text-[13px] text-[var(--color-text-secondary)] whitespace-pre-wrap">
                    {preview.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}
                </ul>
            )}

            {/* ── App Switcher Row ── */}
            {applications.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] font-semibold uppercase
                                     tracking-[0.06em] text-[var(--color-text-tertiary)] mr-1 shrink-0">
                        Current App
                    </span>
                    {applications.map(app => (
                        <button
                            key={app.installationId}
                            onClick={() => setActiveAppId(app.installationId)}
                            className={`
                                h-8 px-3.5 rounded-full text-[13px] font-medium
                                transition-all duration-200 select-none
                                active:scale-[0.97]
                                ${app.installationId === activeApp?.installationId
                                    ? 'text-[var(--color-accent)] bg-[var(--color-accent)]/10'
                                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-white/5'}
                            `}
                        >
                            {app.name}
                        </button>
                    ))}
                </div>
            )}

            {/* ── Active App Content ── */}
            {activeApp ? (
                <ApplicationBlock key={activeApp.installationId} app={activeApp} />
            ) : (
                <div className="text-[13px] text-[var(--color-text-tertiary)] py-4">
                    No applications found.
                </div>
            )}

            {/* ── Agent Thinking (floating badge, bottom-right) ── */}
            {agentThinking && (
                <div className="fixed bottom-6 right-6 w-72 mat-lg-clear rounded-2xl
                                px-4 py-3
                                shadow-[0_8px_24px_var(--mat-shadow-color)] z-50">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
                        <span className="text-[11px] font-semibold uppercase
                                         tracking-[0.05em] text-[var(--color-text-secondary)]">
                            Agent Thinking
                        </span>
                    </div>
                    <pre className="text-[11px] font-mono text-[var(--color-text-primary)]
                                    whitespace-pre-wrap max-h-36 overflow-y-auto">
                        {agentThinking}
                    </pre>
                </div>
            )}
        </div>
    );
}
