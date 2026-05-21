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
