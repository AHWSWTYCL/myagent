import Anthropic from '@anthropic-ai/sdk'
import type { PermissionAnswer } from './permissionhook.js'

const SYSTEM = `You are a security policy agent. Given a tool call description, decide whether to allow it.
Respond with ONLY a JSON object: {"decision":"allow"} or {"decision":"block","reason":"<short reason>"}.

Rules — ALLOW:
- Read-only operations (read_file, list_dir, web_search, web_fetch): always allow
- bash commands that read/inspect (ls, cat, grep, git status, git log, git diff, npm test, npx vitest, etc.): allow
- bash commands that modify the current project (npm install/mkdir/cp/mv/git add/rm non-system files): allow
- bash commands that run tests, builds, linters (npm run, npx, make, cargo build, go build, tsc, etc.): allow
- bash commands that start dev servers for local development: allow
- write_file to source code, config files, or any path inside the project: allow

Rules — BLOCK:
- write_file to system sensitive paths (/etc, /sys, /proc, ~/.ssh, ~/.aws, ~/.config): block
- bash commands that delete system files or modify system configurations: block
- bash commands that exfiltrate data to external services (curl/wget with data POST, nc sending files): block
- bash commands that modify permissions on system paths (chmod 777 /etc): block
- bash commands that shutdown/reboot the system: block
- bash commands that pipe remote scripts to shell: block`

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
      // Network / API failure — fail CLOSED. In auto mode the caller will
      // respect this decision directly and block the operation, never asking
      // the user interactively.
      return 'no'
    }
  }
}
