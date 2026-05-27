import { Tool, type ToolRenderHeader } from './tool.js'

const MAX_RESULTS = 5
const TIMEOUT_MS = 15_000

interface SearchResult {
  title: string
  url: string
  snippet: string
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/g, ' ')
}

function parseResults(html: string): SearchResult[] {
  const titleRe = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g
  const snippetRe = /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/g

  const titles: Array<{ url: string; title: string }> = []
  let m: RegExpExecArray | null

  while ((m = titleRe.exec(html)) !== null) {
    const url = m[1]
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim())
    titles.push({ url, title })
  }

  const snippets: string[] = []
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()))
  }

  return titles.slice(0, MAX_RESULTS).map((t, i) => ({
    title: t.title,
    url: t.url,
    snippet: snippets[i] ?? '',
  }))
}

export class WebSearchTool extends Tool {
  get name() { return 'web_search' }

  get description() {
    return 'Search the web via Bing and return the top results with titles, URLs, and snippets.'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    }
  }

  get parallelSafe() { return true }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    return { label: 'WebSearch', args: Tool.truncate(String(input.query ?? ''), 80) }
  }

  renderToolResult(output: string, isError: boolean): string[] {
    return Tool.summarize(output, isError)
  }

  async checkPermission(_args: Record<string, unknown>): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(args: any): Promise<string> {
    const { query } = args
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(searchUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      clearTimeout(timer)
      const html = await res.text()
      const results = parseResults(html)
      if (results.length === 0) return 'No results found.'
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n')
    } catch (err: any) {
      clearTimeout(timer)
      return `Search error: ${err.message}`
    }
  }
}
