import { Tool } from './tool.js'

const MAX_CONTENT_CHARS = 50_000
const TIMEOUT_MS = 15_000

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// 已知安全的域名——直接放行，不触发权限链
const SAFE_DOMAINS = [
  'github.com', 'raw.githubusercontent.com',
  'stackoverflow.com', 'stackexchange.com',
  'developer.mozilla.org',  'wiki', 'wikipedia.org',
  'npmjs.com', 'npmjs.org', 'pypi.org',
  'docs.', 'learn.microsoft.com',
  'react.dev', 'nextjs.org', 'vuejs.org',
  'nodejs.org', 'typescriptlang.org',
  'deno.land', 'bun.sh', 'rust-lang.org',
  'docker.com', 'kubernetes.io',
  'json-schema.org', 'swagger.io',
  'trpc.io', 'graphql.org',
  'anthropic.com', 'claude.ai',
]

// 明显可疑的 URL 模式——直接阻断
const SUSPICIOUS_PATTERNS = [
  /^data:/i,                                          // data: URIs
  /^file:/i,                                          // file: URIs
  /^javascript:/i,                                    // javascript: URIs
  /^vbscript:/i,                                      // vbscript: URIs
  /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./,        // 内网 IP
  /^127\./,                                           // localhost
  /^localhost/i,                                      // localhost 域名
  /\.(onion|i2p)$/i,                                  // 暗网
]

export class FetchTool extends Tool {
  get name() { return 'web_fetch' }

  get description() {
    return 'Fetch the content of a URL and return it as plain text. HTML is automatically stripped to readable text.'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    }
  }

  get parallelSafe() { return true }

  async checkPermission(args: Record<string, unknown>): Promise<import('./tool.js').ToolPermissionResult> {
    const url = (args.url ?? '') as string
    if (!url.trim()) return { action: 'defer' }

    // 可疑模式 → 阻断
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(url)) {
        return { action: 'block', reason: `URL blocked: ${url.match(pattern)?.[0]} URLs are not allowed` }
      }
    }

    // 安全域名 → 直接放行
    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname.toLowerCase()
      for (const domain of SAFE_DOMAINS) {
        if (domain.endsWith('.') ? hostname.startsWith(domain) : (hostname === domain || hostname.endsWith('.' + domain))) {
          return { action: 'continue' }
        }
      }
    } catch {
      // URL 解析失败，交给上层
    }

    // 未知域名 → 交给上层决定
    return { action: 'defer' }
  }

  async execute(args: any): Promise<string> {
    const { url } = args
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; myagent/1.0)' },
      })
      clearTimeout(timer)
      const contentType = res.headers.get('content-type') ?? ''
      let text = await res.text()
      if (contentType.includes('html')) text = stripHtml(text)
      if (text.length > MAX_CONTENT_CHARS) text = text.slice(0, MAX_CONTENT_CHARS) + '\n...[truncated]'
      return `Status: ${res.status}\nURL: ${res.url}\n\n${text}`
    } catch (err: any) {
      clearTimeout(timer)
      return `Error fetching ${url}: ${err.message}`
    }
  }
}
