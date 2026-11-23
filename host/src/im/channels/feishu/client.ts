export type FeishuDomain = 'feishu' | 'lark'

export function buildFeishuApiBase(domain: FeishuDomain, apiBaseUrl?: string): string {
  if (apiBaseUrl && apiBaseUrl.trim()) {
    return apiBaseUrl.trim()
  }

  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}
