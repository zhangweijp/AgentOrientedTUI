import { z } from "zod"

const imAccountSchema = z.object({
  enabled: z.boolean().optional(),
  sessionScope: z.enum(["peer", "peer_sender", "peer_thread", "peer_thread_sender"]).optional(),
  domain: z.string().optional(),
  connectionMode: z.enum(["webhook", "websocket"]).optional(),
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  botToken: z.string().optional(),
  botAgentId: z.string().optional(),
  verificationToken: z.string().optional(),
  encryptKey: z.string().optional(),
  signingSecret: z.string().optional(),
  apiBaseUrl: z.string().optional(),
  requestTimeoutMs: z.number().positive().optional(),
  dmPolicy: z.enum(["open", "allowlist", "pairing"]).optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  pairingApprovers: z.array(z.union([z.string(), z.number()])).optional(),
  pairingCodeTtlMs: z.number().positive().optional(),
  pairingMaxPending: z.number().int().positive().optional(),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  requireMention: z.boolean().optional(),
}).strict()

const imChannelSchema = imAccountSchema.extend({
  accounts: z.record(z.string(), imAccountSchema).optional(),
})

export const ImConfig = z.object({
  enabled: z.boolean().optional(),
  channels: z.object({
    feishu: imChannelSchema.optional(),
    lark: imChannelSchema.optional(),
  }).strict().optional(),
}).strict()
export type ImConfig = z.infer<typeof ImConfig>
