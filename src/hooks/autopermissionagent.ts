import Anthropic from '@anthropic-ai/sdk'
import type { PermissionAnswer } from './permissionhook.js'

const SYSTEM = `You are a security policy agent. Given a tool call description, decide whether to allow it.
Respond with ONLY a JSON object: {"decision":"allow"} or {"decision":"block","reason":"<short reason>"}.

Rules:
- Read-only operations (read_file, list_dir, web_search, web_fetch): always allow
- bash commands that only read/inspect (ls, cat, grep, git status, git log, git diff, npm test, etc.): allow
- bash commands that modify the filesystem, install packages, run servers, or delete files: block
- write_file to source code or config files: allow (the main agent already decided to write it)
- write_file to sensitive paths (/etc, ~/.ssh, ~/.aws, system dirs): block
- Anything that could exfiltrate data to external services: block`

export class AutoPermissionAgent {
  constructor(private client: Anthropic) {}

  async decide(prompt: string): Promise<PermissionAnswer> {
    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 128,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      })

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('')
        .trim()

      // Extract JSON even if the model wraps it in markdown
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) {
        // Couldn't parse a decision — fail closed and let the human decide.
        return 'no'
      }

      const parsed = JSON.parse(match[0]) as { decision: string; reason?: string }
      return parsed.decision === 'allow' ? 'yes' : 'no'
    } catch {
      // Network / API failure — fail CLOSED. The security layer must not silently
      // allow unverified actions; caller (PermissionHook) falls back to asking
      // the user interactively.
      return 'no'
    }
  }
}
