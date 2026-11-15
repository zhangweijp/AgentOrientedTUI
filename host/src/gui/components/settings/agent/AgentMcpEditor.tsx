/**
 * AgentMcpEditor — MCP server & per-tool toggle editor
 *
 * UI mirrors the ChatArea MCP input-bar popover:
 *   ACTIVE section  → <details> per server with tool-level toggles
 *   INACTIVE section → greyed-out list with "Open Settings To Activate →"
 */
import React, { useEffect, useState } from 'react';
import { AgentEditorModal } from './AgentEditorModal.js';
import { useChatBridge } from '../../../ChatBridge.js';
import { buildMcpToolItemKey, hasInvalidMcpToolKeys, isMcpToolItemKey, MCP_PERMISSION_RECONFIGURE } from '../../../../shared/source-control-keys.js';

interface McpTool { name: string; description: string; enabled: boolean; }
interface McpServer { name: string; connected: boolean; status?: string; tools: McpTool[]; }

export interface AgentMcpEditorProps {
    isOpen: boolean;
    onClose: () => void;
    value: string[];
    disabledTools: string[];
    onSave: (enabledMCPs: string[], disabledMcpTools: string[]) => void;
    onOpenMcpSettings?: () => void;
}

export const AgentMcpEditor: React.FC<AgentMcpEditorProps> = ({
    isOpen, onClose, value, disabledTools, onSave, onOpenMcpSettings,
}) => {
    const bridge = useChatBridge();
    const [servers, setServers] = useState<McpServer[]>([]);
    const [enabledServers, setEnabledServers] = useState<Set<string>>(new Set(value));
    const [disabledToolSet, setDisabledToolSet] = useState<Set<string>>(new Set(disabledTools));
    const [loading, setLoading] = useState(true);

    const needsRepair = hasInvalidMcpToolKeys(disabledTools);

    useEffect(() => {
        if (!isOpen) return;
        setEnabledServers(new Set(needsRepair ? [] : value));
        setDisabledToolSet(new Set(Array.isArray(disabledTools) ? disabledTools.filter(isMcpToolItemKey) : []));
        (async () => {
            setLoading(true);
            try {
                const runtime = await bridge.getTrpcClient().mcp.getRuntime.query();
                const list: McpServer[] = Object.entries(runtime).map(([name, server]) => ({
                    name, connected: server.status === 'connected', status: server.status, tools: server.tools,
                }));
                setServers(list);
                const connected = new Set(list.filter(server => server.connected).map(server => server.name));
                setEnabledServers(previous => new Set([...previous].filter(name => connected.has(name))));
            } catch {
                setServers([]);
            } finally {
                setLoading(false);
            }
        })();
    }, [isOpen, value, disabledTools, needsRepair, bridge]);

    const toggleServer = (name: string) =>
        setEnabledServers(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });

    const toggleTool = (serverName: string, toolName: string, nextEnabled: boolean) =>
        setDisabledToolSet(prev => {
            const next = new Set(prev);
            const key = buildMcpToolItemKey(serverName, toolName);
            if (nextEnabled) next.delete(key);
            else next.add(key);
            return next;
        });

    const handleSave = () => {
        onSave(Array.from(enabledServers), Array.from(disabledToolSet));
        onClose();
    };

    const activeServers = servers.filter(s => s.connected);
    const inactiveServers = servers.filter(s => !s.connected);

    const anyEnabled = enabledServers.size > 0;
    const toggleAll = (v: boolean) => setEnabledServers(v ? new Set(activeServers.map(s => s.name)) : new Set());

    const renderToggle = (checked: boolean, onChange: (v: boolean) => void, disabled = false) => (
        <button type="button" role="switch" aria-checked={checked} disabled={disabled}
            onClick={e => { e.preventDefault(); e.stopPropagation(); onChange(!checked); }}
            className={`relative inline-flex items-center shrink-0 rounded-full transition-colors duration-200 w-8 h-[18px]
                ${checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--mat-border)]'}
                ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
            <span className={`inline-block rounded-full bg-white shadow transition-transform duration-200 w-3.5 h-3.5 translate-x-0.5 ${checked ? 'translate-x-3' : ''}`} />
        </button>
    );

    return (
        <AgentEditorModal
            isOpen={isOpen}
            onClose={onClose}
            title="MCP Servers"
            footer={
                <>
                    <button onClick={onClose} className="lg-btn hover:bg-[var(--mat-content-card-hover-bg)] px-4 py-2 rounded-xl text-[13px]">Cancel</button>
                    <button onClick={handleSave} className="lg-btn rounded-full bg-[var(--color-accent)] text-white border-transparent hover:bg-[var(--color-accent)]/90 px-6 py-2 text-[13px]">Save</button>
                </>
            }
        >
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-tertiary)]">
                    <span aria-hidden="true" className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-[var(--mat-border)] text-[10px] leading-none">i</span>
                    <span>Enable MCP servers and individual tools for this agent.</span>
                </div>
                {renderToggle(anyEnabled, toggleAll)}
            </div>
            {needsRepair && <p role="alert" className="text-[12px] text-[var(--color-danger)]">{MCP_PERMISSION_RECONFIGURE}</p>}
            {loading ? (
                <div className="py-6 text-center text-[14px] text-[var(--color-text-tertiary)]">Loading MCP servers...</div>
            ) : servers.length === 0 ? (
                <div className="text-[13px] text-[var(--color-text-tertiary)]">No MCP servers configured</div>
            ) : (
                <div className="space-y-3 max-h-[380px] overflow-y-auto custom-scrollbar">
                    {/* ── Active ── */}
                    {activeServers.length > 0 && (
                        <div>
                            <div className="text-[12px] uppercase tracking-wide text-[var(--color-text-tertiary)] mb-1">Active</div>
                            <div className="space-y-2">
                                {activeServers.map(srv => {
                                    const srvEnabled = enabledServers.has(srv.name);
                                    return (
                                        <details key={srv.name} className="rounded-xl bg-[var(--mat-content-card-hover-bg)] p-2" open>
                                            <summary className="list-none cursor-pointer flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-1.5 min-w-0">
                                                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--color-success)]" />
                                                    <span className="text-[12px] font-medium text-[var(--color-text-tertiary)] truncate">{srv.name}</span>
                                                </div>
                                                {renderToggle(srvEnabled, () => toggleServer(srv.name))}
                                            </summary>
                                            <div className={`mt-1 space-y-1 ${srvEnabled ? '' : 'opacity-45'}`}>
                                                {srv.tools.map(tool => {
                                                    const toolEnabled = tool.enabled && !disabledToolSet.has(buildMcpToolItemKey(srv.name, tool.name));
                                                    return (
                                                        <label key={`mcp-tool-${srv.name}-${tool.name}`} className="flex items-center justify-between gap-2 text-[13px] text-[var(--color-text-secondary)]">
                                                            <span className="truncate">{tool.name}</span>
                                                            {renderToggle(toolEnabled, (v) => toggleTool(srv.name, tool.name, v), !srvEnabled || !tool.enabled)}
                                                        </label>
                                                    );
                                                })}
                                                {srv.tools.length === 0 && (
                                                    <div className="text-[12px] text-[var(--color-text-tertiary)] py-1">No tools listed</div>
                                                )}
                                            </div>
                                        </details>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {/* ── Inactive ── */}
                    {inactiveServers.length > 0 && (
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <div className="text-[12px] uppercase tracking-wide text-[var(--color-text-tertiary)]">Inactive</div>
                                {onOpenMcpSettings && (
                                    <button type="button" onClick={() => { onClose(); onOpenMcpSettings(); }}
                                        className="text-[12px] text-[var(--color-accent)] hover:underline">
                                        Open Settings To Activate →
                                    </button>
                                )}
                            </div>
                            <div className="rounded-xl bg-[var(--mat-content-card-hover-bg)] p-2 space-y-1.5 opacity-50">
                                {inactiveServers.map(srv => (
                                    <div key={srv.name} className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-tertiary)]">
                                        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--color-text-tertiary)]" />
                                        <span className="truncate">{srv.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </AgentEditorModal>
    );
};
