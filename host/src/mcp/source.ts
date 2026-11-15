import type { ContextDrivenSource, DrivenSourceContext } from "@aotui/agent-driver-v2";
import { MCP, McpToolUnavailableError } from "./index.js";
import { Log } from "./utils.js";
import { isMcpToolItemKey } from "../shared/source-control-keys.js";

const log = Log.create({ service: "mcp-driven-source" });

export class McpDrivenSource implements ContextDrivenSource {
    public readonly name = "mcp-driven-source";
    private listeners: (() => void)[] = [];
    private sourceEnabled = true;
    private disabledTools = new Set<string>();
    private disabledServers = new Set<string>();
    constructor(private readonly allowedServers?: ReadonlySet<string>) {}

    public triggerUpdate() {
        for (const listener of this.listeners) {
            listener();
        }
    }

    setEnabled(enabled: boolean): void {
        this.sourceEnabled = enabled;
        this.triggerUpdate();
    }

    setToolEnabled(toolName: string, enabled: boolean): void {
        if (enabled) {
            this.disabledTools.delete(toolName);
        } else {
            this.disabledTools.add(toolName);
        }
        this.triggerUpdate();
    }

    setServerEnabled(serverName: string, enabled: boolean): void {
        if (enabled) {
            this.disabledServers.delete(serverName);
        } else {
            this.disabledServers.add(serverName);
        }
        this.triggerUpdate();
    }

    getControlState(): { enabled: boolean; disabledTools: string[] } {
        return {
            enabled: this.sourceEnabled,
            disabledTools: Array.from(this.disabledTools).sort((a, b) => a.localeCompare(b)),
        };
    }

    private isAvailable(): boolean {
        return this.sourceEnabled && [...this.disabledTools].every(isMcpToolItemKey);
    }

    private isToolAllowed(toolKey: string, serverName: string): boolean {
        return (this.allowedServers?.has(serverName) ?? true)
            && !this.disabledTools.has(toolKey) && !this.disabledServers.has(serverName);
    }

    onUpdate(callback: () => void): () => void {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter((cb) => cb !== callback);
        };
    }

    async getContext(): Promise<DrivenSourceContext> {
        log.info("Fetching tools from MCP manager");
        if (!this.isAvailable()) return { messages: [], tools: {} };
        try {
            const catalog = await MCP.tools();
            if (!this.isAvailable()) return { messages: [], tools: {} };
            const eligible = Object.entries(catalog)
                .filter(([name, entry]) => this.isToolAllowed(name, entry.serverName));
            const tools = Object.fromEntries(eligible.map(([name, entry]) => [name, entry.tool]));
            // Binding fixes both the function and its original Tool receiver.
            const executors = new Map(eligible.map(([name, entry]) => [name, {
                serverName: entry.serverName, run: entry.tool.execute?.bind(entry.tool),
            }]));
            return {
                messages: [], tools,
                executeTool: async (toolName, args, toolCallId) => {
                    const executor = executors.get(toolName);
                    if (!executor?.run) return undefined;
                    if (!this.isAvailable() || !this.isToolAllowed(toolName, executor.serverName)) {
                        return { toolName, toolCallId, outcomeStatus: 'rejected',
                            error: { code: 'E_SOURCE_UNAVAILABLE', message: 'The MCP tool source is no longer active' } };
                    }
                    log.info("Executing MCP tool", toolName);
                    try {
                        const result = await executor.run(args, { toolCallId, messages: [] });
                        log.info(`MCP tool ${toolName} executed successfully, triggering update signal`);
                        return { toolCallId, toolName, result: typeof result === 'string' ? result : JSON.stringify(result) };
                    } catch (error) {
                        if (error instanceof McpToolUnavailableError) {
                            return { toolName, toolCallId, outcomeStatus: 'rejected',
                                error: { code: 'E_SOURCE_UNAVAILABLE', message: error.message } };
                        }
                        log.error(`Error executing MCP tool ${toolName}`, error);
                        log.info(`MCP tool ${toolName} execution failed, triggering update signal with error`);
                        return { toolCallId, toolName, result: `Error: ${(error as Error).message}` };
                    } finally {
                        for (const listener of this.listeners) {
                            try {
                                listener();
                            } catch (error) {
                                log.error("Failed to notify MCP tool update subscriber", error);
                            }
                        }
                    }
                },
            };
        } catch (error) {
            log.error("Failed to fetch tools", error);
            return { messages: [], tools: {} };
        }
    }
}
