import type { ContextDrivenSource, DrivenSourceContext } from "@aotui/agent-driver-v2";
import { MCP } from "./index.js";
import { Bus, BusEvent } from "./utils.js";
import { Log } from "./utils.js";
import { buildMcpToolKeyPrefix } from "../shared/source-control-keys.js";

const log = Log.create({ service: "mcp-driven-source" });

export class McpDrivenSource implements ContextDrivenSource {
    public readonly name = "mcp-driven-source";
    private listeners: (() => void)[] = [];
    private sourceEnabled = true;
    private disabledTools = new Set<string>();
    private disabledServers = new Set<string>();

    constructor() {
        // Assume MCP updates will be polled or events emitted
    }

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

    private buildServerPrefix(serverName: string): string {
        return buildMcpToolKeyPrefix(serverName);
    }

    private isToolAllowed(toolKey: string): boolean {
        if (this.disabledTools.has(toolKey)) {
            return false;
        }

        for (const serverName of this.disabledServers) {
            if (toolKey.startsWith(this.buildServerPrefix(serverName))) {
                return false;
            }
        }

        return true;
    }

    onUpdate(callback: () => void): () => void {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter((cb) => cb !== callback);
        };
    }

    async getContext(): Promise<DrivenSourceContext> {
        log.info("Fetching tools from MCP manager");
        if (!this.sourceEnabled) return { messages: [], tools: {} };
        try {
            const allTools: DrivenSourceContext['tools'] = await MCP.tools();
            const tools = Object.fromEntries(Object.entries(allTools)
                .filter(([name]) => this.sourceEnabled && this.isToolAllowed(name)));
            // Binding fixes both the function and its original Tool receiver.
            const executors = new Map(Object.entries(tools).map(([name, tool]) => [name, tool.execute?.bind(tool)]));
            return {
                messages: [], tools,
                executeTool: async (toolName, args, toolCallId) => {
                    if (!Object.hasOwn(tools, toolName)) return undefined;
                    if (!this.sourceEnabled || !this.isToolAllowed(toolName)) {
                        return { toolName, toolCallId, outcomeStatus: 'rejected',
                            error: { code: 'E_SOURCE_UNAVAILABLE', message: 'The MCP tool source is no longer active' } };
                    }
                    log.info("Executing MCP tool", toolName);
                    try {
                        const result = await executors.get(toolName)!(args, { toolCallId, messages: [] });
                        log.info(`MCP tool ${toolName} executed successfully, triggering update signal`);
                        return { toolCallId, toolName, result: typeof result === 'string' ? result : JSON.stringify(result) };
                    } catch (error) {
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
