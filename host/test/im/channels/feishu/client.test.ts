import { describe, expect, it } from 'vitest'
import { buildFeishuApiBase } from '../../../../src/im/channels/feishu/client.js'

describe('feishu client helpers', () => {
  it('builds default api base by domain', () => {
    expect(buildFeishuApiBase('feishu')).toBe('https://open.feishu.cn')
    expect(buildFeishuApiBase('lark')).toBe('https://open.larksuite.com')
  })

  it('prefers explicit api base url override', () => {
    expect(buildFeishuApiBase('feishu', 'https://proxy.internal')).toBe('https://proxy.internal')
  })
})
