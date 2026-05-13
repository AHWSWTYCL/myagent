import fs from 'fs'
import os from 'os'
import path from 'path'

export interface ClaudeSettings {
  authToken?: string
  apiKey?: string
  baseURL?: string
}

export function loadClaudeSettings(): ClaudeSettings {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')

  if (!fs.existsSync(settingsPath)) {
    throw new Error(`settings.json not found at ${settingsPath}`)
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8')
  const settings = JSON.parse(raw)
  const env = settings.env ?? {}

  const authToken = env.ANTHROPIC_AUTH_TOKEN
  const apiKey = env.ANTHROPIC_API_KEY
  const baseURL = env.ANTHROPIC_BASE_URL

  if (!authToken && !apiKey) {
    throw new Error(
      'Neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY found in ~/.claude/settings.json env',
    )
  }

  return { authToken, apiKey, baseURL }
}
