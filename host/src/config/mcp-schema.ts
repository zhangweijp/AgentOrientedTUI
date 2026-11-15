import { z } from "zod"

const serverOptions = {
  enabled: z.boolean().optional(),
  disabledTools: z.array(z.string().min(1)).optional(),
  timeout: z.number().int().positive().optional(),
}

const McpLocal = z.object({
  ...serverOptions,
  type: z.literal("local"),
  command: z.array(z.string()).min(1).refine(command => Boolean(command[0]?.trim()), "Command must name an executable"),
  environment: z.record(z.string(), z.string()).optional(),
}).strict()

const McpRemote = z.object({
  ...serverOptions,
  type: z.literal("remote"),
  url: z.string().url().refine(url => /^https?:\/\//i.test(url), "Use an HTTP or HTTPS URL"),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: z.union([z.literal(false), z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scope: z.string().optional(),
  }).strict()]).optional(),
}).strict()

export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
export type Mcp = z.infer<typeof Mcp>
export const McpConfig = z.record(z.string().min(1), Mcp)
