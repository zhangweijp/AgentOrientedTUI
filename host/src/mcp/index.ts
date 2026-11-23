import type { JSONSchema7 } from "ai"
import { jsonSchema, type Tool } from "@aotui/agent-driver-v2"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { homedir } from "node:os"
import { isDeepStrictEqual } from "node:util"
import hostPackage from "../../package.json" with { type: "json" }
import { Config } from "../config/config.js"
import type { Mcp } from "../config/mcp-schema.js"
import { Log, withTimeout } from "./utils.js"
import { McpOAuthProvider } from "./oauth-provider.js"
import { buildMcpToolItemKey } from "../shared/source-control-keys.js"

export class McpToolUnavailableError extends Error {}

export namespace MCP {
  const log = Log.create({ service: "mcp" })
  const DEFAULT_TIMEOUT = 30_000
  const clientInfo = { name: "agentina", version: hostPackage.version }

  type Status =
    | { status: "connected" | "disabled" | "needs_auth" }
    | { status: "failed" | "needs_client_registration"; error: string }
  type MCPClient = Client

  // Register notification handlers for MCP client
  function registerNotificationHandlers(client: MCPClient, serverName: string) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      log.info("tools list changed notification received", { server: serverName })
    })
  }

  function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, serverName: string, timeout?: number): Tool {
    const inputSchema = mcpTool.inputSchema
    const schema: JSONSchema7 = {
      ...(inputSchema as JSONSchema7),
      type: "object",
      properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    }

    return {
      description: mcpTool.description ?? "",
      inputSchema: jsonSchema(schema),
      execute: async (args: unknown) => {
        const s = await state()
        const { mcp } = await Config.getMcp()
        const config = Object.hasOwn(mcp, serverName) ? mcp[serverName] : undefined
        if (s.clients[serverName] !== client || !config || config.enabled === false
          || !sameConnection(config, s.connectedConfig[serverName]) || config.disabledTools?.includes(mcpTool.name)) {
          throw new McpToolUnavailableError("The MCP tool is no longer available. Refresh the current tool list.")
        }

        return client.callTool({
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        }, CallToolResultSchema, {
          resetTimeoutOnProgress: true,
          timeout,
        })
      },
      type: "dynamic",
    }
  }

  function sameConnection(a: Mcp, b: Mcp): boolean {
    const { enabled: _aEnabled, disabledTools: _aDisabled, ...aConnection } = a
    const { enabled: _bEnabled, disabledTools: _bDisabled, ...bConnection } = b
    return isDeepStrictEqual(aConnection, bConnection)
  }

  let connectionState: ReturnType<typeof initialize> | undefined

  function state() {
    return connectionState ??= initialize()
  }

  async function initialize() {
    const { mcp: config } = await Config.getMcp()
    const clients: Record<string, MCPClient> = Object.create(null)
    const connectedConfig: Record<string, Mcp> = Object.create(null)
    const status: Record<string, Status> = Object.create(null)

    await Promise.all(
      Object.entries(config).map(async ([key, mcp]) => {
        if (mcp.enabled === false) {
          status[key] = { status: "disabled" }
          return
        }

        const result = await create(key, mcp).catch(() => undefined)
        if (!result) return

        status[key] = result.status

        if (result.mcpClient) {
          clients[key] = result.mcpClient
          connectedConfig[key] = mcp
        }
      }),
    )
    return {
      status,
      clients,
      connectedConfig,
    }
  }

  async function create(key: string, mcp: Mcp) {
    if (mcp.enabled === false) {
      log.info("mcp server disabled", { key })
      return {
        mcpClient: undefined,
        status: { status: "disabled" as const },
      }
    }

    log.info("found", { key, type: mcp.type })
    let mcpClient: MCPClient | undefined
    let status: Status | undefined = undefined

    if (mcp.type === "remote") {
      // OAuth is enabled by default for remote servers unless explicitly disabled with oauth: false
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
          },
        )
      }

      const transports = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      let lastError: Error | undefined
      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      for (const { name, transport } of transports) {
        try {
          const client = new Client(clientInfo)
          await withTimeout(client.connect(transport), connectTimeout)
          registerNotificationHandlers(client, key)
          mcpClient = client
          log.info("connected", { key, transport: name })
          status = { status: "connected" }
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          // Handle OAuth-specific errors
          if (error instanceof UnauthorizedError) {
            log.info("mcp server requires authentication", { key, transport: name })

            // Check if this is a "needs registration" error
            if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
              status = {
                status: "needs_client_registration" as const,
                error: "Server does not support dynamic client registration. Please provide clientId in config.",
              }
            } else {
              status = { status: "needs_auth" }
            }
            break
          }

          log.debug("transport connection failed", {
            key,
            transport: name,
            url: mcp.url,
            error: lastError.message,
          })
          status = {
            status: "failed" as const,
            error: lastError.message,
          }
        }
      }
    }

    if (mcp.type === "local") {
      const [cmd, ...args] = mcp.command
      const cwd = homedir()
      const env = Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ))
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: { ...env, ...mcp.environment },
      })
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      try {
        const client = new Client(clientInfo)
        await withTimeout(client.connect(transport), connectTimeout)
        registerNotificationHandlers(client, key)
        mcpClient = client
        status = {
          status: "connected",
        }
      } catch (error) {
        log.error("local mcp startup failed", {
          key,
          command: mcp.command,
          cwd,
          error: error instanceof Error ? error.message : String(error),
        })
        status = {
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    status ??= { status: "failed", error: "Unknown error" }

    if (!mcpClient) {
      return {
        mcpClient: undefined,
        status,
      }
    }

    const result = await withTimeout(mcpClient.listTools(), mcp.timeout ?? DEFAULT_TIMEOUT).catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return undefined
    })
    if (!result) {
      await mcpClient.close().catch((error) => {
        log.error("Failed to close MCP client", {
          error,
        })
      })
      status = {
        status: "failed",
        error: "Failed to get tools",
      }
      return {
        mcpClient: undefined,
        status: {
          status: "failed" as const,
          error: "Failed to get tools",
        },
      }
    }

    log.info("create() successfully created client", { key, toolCount: result.tools.length })
    return {
      mcpClient,
      status,
    }
  }

  export async function status(): Promise<Record<string, Status>> {
    const { mcp, invalid } = await Config.getMcp()
    const s = await state()
    const entries = Object.entries(mcp).map(([name, config]): [string, Status] => {
      if (config.enabled === false) return [name, { status: "disabled" }]
      if (s.clients[name] && !sameConnection(config, s.connectedConfig[name])) {
        return [name, { status: "failed", error: "MCP settings changed. Re-enable this server in Settings → MCP." }]
      }
      return [name, s.status[name] ?? { status: "disabled" }]
    })
    for (const [name, error] of Object.entries(invalid)) entries.push([name, { status: "failed", error }])
    return Object.fromEntries(entries)
  }

  function activeClients(s: Awaited<ReturnType<typeof state>>, config: Record<string, Mcp>) {
    return Object.fromEntries(Object.entries(s.clients).filter(([name]) =>
      Object.hasOwn(config, name) && config[name].enabled !== false && sameConnection(config[name], s.connectedConfig[name]),
    ))
  }

  export async function clients() {
    const { mcp } = await Config.getMcp()
    return activeClients(await state(), mcp)
  }

  async function closeClient(s: Awaited<ReturnType<typeof state>>, name: string) {
    const client = s.clients[name]
    delete s.clients[name]
    delete s.connectedConfig[name]
    await client?.close().catch(error => log.error("Failed to close MCP client", { name, error }))
  }

  export async function connect(name: string): Promise<Status> {
    const s = await state()
    const { mcp, invalid } = await Config.getMcp()
    const config = Object.hasOwn(mcp, name) ? mcp[name] : undefined
    if (!config || config.enabled === false) {
      await closeClient(s, name)
      return s.status[name] = Object.hasOwn(invalid, name)
        ? { status: "failed", error: invalid[name] }
        : { status: "disabled" }
    }
    if (s.clients[name] && sameConnection(config, s.connectedConfig[name])) return s.status[name]

    await closeClient(s, name)
    const result = await create(name, config)
    if (result.mcpClient) {
      s.clients[name] = result.mcpClient
      s.connectedConfig[name] = config
    }
    return s.status[name] = result.status
  }

  export async function disconnect(name: string) {
    const s = await state()
    await closeClient(s, name)
    s.status[name] = { status: "disabled" }
  }

  export async function tools(): Promise<Record<string, { serverName: string; tool: Tool }>> {
    const { mcp, timeout } = await Config.getMcp()
    const s = await state()
    const listed = await Promise.all(Object.entries(activeClients(s, mcp)).map(async ([serverName, client]) => {
      try {
        const { tools } = await client.listTools()
        return { serverName, client, tools }
      } catch (error) {
        if (s.clients[serverName] === client) {
          await closeClient(s, serverName)
          s.status[serverName] = { status: "failed", error: error instanceof Error ? error.message : String(error) }
        }
        return { serverName, client, tools: [] }
      }
    }))

    const byKey = new Map<string, { serverName: string; tool: Tool }>()
    const seen = new Set<string>()
    for (const { serverName, client, tools } of listed) {
      const config = mcp[serverName]
      for (const definition of tools) {
        const key = buildMcpToolItemKey(serverName, definition.name)
        if (seen.has(key)) {
          byKey.delete(key)
          log.warn("MCP tool key is ambiguous", { key })
          continue
        }
        seen.add(key)
        if (config.disabledTools?.includes(definition.name)) continue
        byKey.set(key, { serverName, tool: convertMcpTool(definition, client, serverName, config.timeout ?? timeout) })
      }
    }
    return Object.fromEntries(byKey)
  }
}
