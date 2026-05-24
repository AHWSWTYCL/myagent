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

// ── Simple retry wrapper ──────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3). Total tries = retries + 1. */
  retries?: number
  /** Base delay in ms (default: 1000). Actual delay = baseDelay * 2^attempt. */
  baseDelay?: number
}

const DEFAULT_RETRIES = 3
const DEFAULT_BASE_DELAY = 1000

/**
 * Wrap an async function with exponential-backoff retry logic.
 * Only retries on retryable errors (429, 5xx, network errors).
 *
 * @example
 *   const response = await withRetry(() => client.messages.create({ ... }))
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { retries = DEFAULT_RETRIES, baseDelay = DEFAULT_BASE_DELAY } = options
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < retries && isRetryable(err)) {
        const delay = baseDelay * Math.pow(2, attempt)
        console.log(`[retry] attempt ${attempt + 1}/${retries} failed, retrying in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    // 429 = rate limited, 5xx = server errors
    return err.status === 429 || (err.status >= 500 && err.status < 600)
  }
  // Network / connection errors (e.g., fetch failed) — retryable
  if (err instanceof TypeError && err.message.includes('fetch')) {
    return true
  }
  return false
}
