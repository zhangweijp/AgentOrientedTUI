/**
 * Config - 项目配置管理模块
 *
 * - MCP 服务器配置持久化（存储于 ~/.agentina/mcp.json）
 * - IM 配置持久化（存储于 ~/.agentina/im.json）
 * - 供 mcp/index.ts 和 trpc/router.ts 使用
 */

import fs from "fs/promises"
import path from "path"
import os from "os"
import type { ModelInputLimits } from "@aotui/agent-driver-v2"

import { ImConfig } from "./im-schema.js"
import { Mcp, McpConfig } from "./mcp-schema.js"

export interface Info {
  $schema?: string
  im?: ImConfig
  mcp?: Record<string, Mcp>
  skills?: {
    enabled?: boolean
    disabledSkills?: string[]
    paths?: string[]
    urls?: string[]
  }
  prompts?: {
    templates?: Array<{
      id: string
      name: string
      content: string
      updatedAt?: number
      createdAt?: number
    }>
  }
  experimental?: {
    mcp_timeout?: number
    contextCompaction?: {
      enabled?: boolean
      minMessages?: number
      keepRecentMessages?: number
      hardFallbackThresholdTokens?: number
    }
    [key: string]: unknown
  }
  agents?: {
    list: Array<{
      id: string
      name: string
      prompt: string
      modelId: string
      enabledApps: string[]
      enabledSkills: Record<string, string[]>
      enabledMCPs: string[]
      disabledMcpTools?: string[]
      skin: {
        working?: string
        idle?: string
        sleeping?: string
        pause?: string
      }
    }>
    activeAgentId?: string | null
  }
  [key: string]: unknown
}

export interface TuiInfo {
  version?: number
  modelInputLimits?: Record<string, ModelInputLimits>
  [key: string]: unknown
}

// ─── 配置文件路径 ─────────────────────────────────────────────────────────────

/** 全局 MCP 配置文件路径 (~/.agentina/mcp.json) */
function getGlobalConfigPath(): string {
  return path.join(os.homedir(), ".agentina", "mcp.json")
}

/** 全局 TUI 配置文件路径 (~/.agentina/config.json) */
function getTuiConfigPath(): string {
  return path.join(os.homedir(), ".agentina", "config.json")
}

/** 全局 IM 配置文件路径 (~/.agentina/im.json) */
function getImConfigPath(): string {
  return path.join(os.homedir(), ".agentina", "im.json")
}

// ─── JSONC 预处理器（单遍字符级状态机）────────────────────────────────────────

/**
 * 单遍字符级状态机，同时完成：
 *   1. JSONC 注释剥离（单行注释和块注释），正确跳过字符串内容
 *   2. JSON 字符串值中裸控制字符转义（0x00-0x1F）
 *
 * 核心原则：只有在字符串外部才识别注释，避免将 URL 中的双斜杠误删。
 */
function preprocessJsonc(text: string): string {
  const out: string[] = []
  let i = 0
  let inString = false
  let escaped = false

  while (i < text.length) {
    const ch = text[i]
    const code = text.charCodeAt(i)

    if (inString) {
      // 上一字符是反斜杠 → 当前字符是转义序列的第二个字符，原样输出
      if (escaped) {
        out.push(ch)
        escaped = false
        i++
        continue
      }
      // 反斜杠 → 开启转义
      if (ch === "\\") {
        out.push(ch)
        escaped = true
        i++
        continue
      }
      // 关闭字符串
      if (ch === '"') {
        inString = false
        out.push(ch)
        i++
        continue
      }
      // 裸控制字符（换行、回车、制表符等）→ 转义为 JSON 合法序列
      if (code < 0x20) {
        if (code === 0x0a) out.push("\\n")
        else if (code === 0x0d) out.push("\\r")
        else if (code === 0x09) out.push("\\t")
        else {
          const hex = code.toString(16).padStart(4, "0")
          out.push("\\u" + hex)
        }
        i++
        continue
      }
      out.push(ch)
      i++
      continue
    }

    // ── 字符串外 ──────────────────────────────────────────────────────
    // 进入字符串
    if (ch === '"') {
      inString = true
      out.push(ch)
      i++
      continue
    }

    // 单行注释 //
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }

    // 块注释 /* ... */
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && i + 1 < text.length && text[i + 1] === "/")) {
        i++
      }
      i += 2 // 跳过 */
      continue
    }

    out.push(ch)
    i++
  }

  return out.join("")
}

// ─── 内部读取函数 ─────────────────────────────────────────────────────────────

async function readConfigFile(filepath: string): Promise<Info> {
  try {
    const text = await fs.readFile(filepath, "utf8")
    return JSON.parse(preprocessJsonc(text)) as Info
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
}

async function readTuiConfigFile(filepath: string): Promise<TuiInfo> {
  try {
    const text = await fs.readFile(filepath, "utf8")
    return JSON.parse(preprocessJsonc(text)) as TuiInfo
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
}

// ─── Config namespace ─────────────────────────────────────────────────────────

function readMcp(config: Info) {
  const entries: Array<[string, Mcp]> = []
  const invalid: Array<[string, string]> = []
  const issues: string[] = []
  const servers: unknown = config.mcp
  if (servers != null && typeof servers === "object" && !Array.isArray(servers)) {
    for (const [name, value] of Object.entries(servers)) {
      const parsed = Mcp.safeParse(value)
      if (name && parsed.success) entries.push([name, parsed.data])
      else {
        const message = `MCP server "${name}" has invalid settings. Reconfigure or explicitly import it in Settings → MCP.`
        invalid.push([name, message])
        issues.push(message)
      }
    }
  } else if (servers !== undefined) {
    issues.push("Invalid mcp section in ~/.agentina/mcp.json. Reconfigure it in Settings → MCP.")
  }
  return { mcp: Object.fromEntries(entries), invalid: Object.fromEntries(invalid), issues, timeout: config.experimental?.mcp_timeout }
}

export namespace Config {
  export type InfoType = Info

  export async function getGlobal(): Promise<Info> {
    const config = await readConfigFile(getGlobalConfigPath())
    return { ...config, mcp: readMcp(config).mcp }
  }

  export async function getMcp() {
    return readMcp(await readConfigFile(getGlobalConfigPath()))
  }

  export async function get(): Promise<Info> {
    const [global, { im }] = await Promise.all([getGlobal(), getGlobalIm()])
    return { ...global, im }
  }

  export async function getGlobalIm(): Promise<{ im: ImConfig; issue?: string }> {
    let file: Info
    try {
      file = await readConfigFile(getImConfigPath())
    } catch (error) {
      console.error("[IM] Cannot read im.json:", error instanceof Error ? error.name : "read error")
      return { im: { enabled: false }, issue: "~/.agentina/im.json could not be read. Reconfigure IM in Settings and save." }
    }

    if (file && !Array.isArray(file) && typeof file === "object" && file.im === undefined) {
      return { im: {} }
    }

    const parsed = ImConfig.safeParse(file?.im)
    if (parsed.success) return { im: parsed.data }

    const location = parsed.error.issues[0]?.path.map(String).join(".")
    return {
      im: { enabled: false },
      issue: `Invalid ~/.agentina/im.json configuration${location ? ` at im.${location}` : ""}. Reconfigure IM in Settings using enabled and save.`,
    }
  }

  export async function replaceGlobalIm(im: ImConfig): Promise<void> {
    const valid = ImConfig.parse(im)
    const filepath = getImConfigPath()
    await fs.mkdir(path.dirname(filepath), { recursive: true })

    let schema: string | undefined
    try {
      schema = (await readConfigFile(filepath))?.$schema
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    await fs.writeFile(filepath, JSON.stringify({ $schema: schema, im: valid }, null, 2), "utf8")
  }

  // Queue complete read/modify/write operations for settings that share mcp.json.
  let globalWrites = Promise.resolve()
  function writeGlobal(edit: (existing: Info) => Info): Promise<Info> {
    const filepath = getGlobalConfigPath()
    const written = globalWrites.then(async () => {
      const existing = await readConfigFile(filepath)
      const next = edit(existing)
      next.$schema ??= "https://opencode.ai/config.json"
      await fs.mkdir(path.dirname(filepath), { recursive: true })
      await fs.writeFile(filepath, JSON.stringify(next, null, 2), "utf8")
      return next
    })
    globalWrites = written.then(() => {}, () => {})
    return written
  }

  export function updateGlobal(patch: Partial<Info> | ((existing: Info) => Partial<Info>)): Promise<Info> {
    return writeGlobal(existing => {
      const changes = typeof patch === "function" ? patch(existing) : patch
      const merged: Info = { ...existing }
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) continue
        if (key === "mcp") merged.mcp = { ...existing.mcp, ...McpConfig.parse(value) }
        else merged[key] = value
      }
      return merged
    })
  }

  export function replaceGlobalMcp(mcp: NonNullable<Info["mcp"]>): Promise<Info> {
    return writeGlobal(existing => ({ ...existing, mcp: McpConfig.parse(mcp) }))
  }

  export async function getTuiConfig(): Promise<TuiInfo> {
    return readTuiConfigFile(getTuiConfigPath())
  }
}
