import Anthropic from '@anthropic-ai/sdk'
import { loadClaudeSettings } from './config.js'

/**
 * Build client options matching Claude Code's own wire format:
 *   - Auth via `Authorization: Bearer ${token}` in defaultHeaders
 *   - `apiKey: null` so the SDK doesn't also add `x-api-key`
 *   - `User-Agent: claude-cli/...` so proxies that gate on this header accept us
 *
 * See Claude-Code/src/services/api/client.ts:105-152 and
 * Claude-Code/src/utils/http.ts:18 for the reference implementation.
 */
export function createClient(): Anthropic {
  const { authToken, apiKey, baseURL } = loadClaudeSettings()

  const token = authToken ?? apiKey
  if (!token) {
    throw new Error('No auth token or API key available')
  }

  return new Anthropic({
    apiKey: null,
    authToken: null,
    ...(baseURL ? { baseURL } : {}),
    defaultHeaders: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'claude-cli/1.0.0 (myagent)',
    },
  })
}
