import { readFile } from 'fs/promises'
import { extname, resolve } from 'path'
import { homedir } from 'os'
import Anthropic from '@anthropic-ai/sdk'

export interface FileAttachment {
  /** Original file path (as typed by user) */
  path: string
  /** File name (basename) */
  name: string
  /** Base64-encoded content */
  base64: string
  /** MIME type */
  mediaType: string
  /** Attachment category for API content block */
  kind: 'image' | 'pdf' | 'text'
}

/**
 * Expand `~` at the start of a path to the user's home directory.
 * Leaves absolute and relative paths unchanged.
 */
function expandTilde(rawPath: string): string {
  if (rawPath.startsWith('~/') || rawPath === '~') {
    return rawPath.replace('~', homedir())
  }
  return rawPath
}

/**
 * Automatically prefix valid file paths with `@`.
 *
 * Splits the input string by whitespace (preserving separators). For each token:
 * - Skips tokens shorter than 2 characters
 * - Skips tokens already starting with `@`
 * - Strips leading/trailing single or double quotes (VS Code terminal wraps
 *   dragged file paths in `'` before inserting into stdin)
 * - Skips tokens that don't start with `/`, `~/`, `./`, or `../`
 * - Resolves the path (expanding `~`) and checks if it's an existing file
 * - Prepends `@` if the path is a valid file, otherwise leaves it unchanged
 *
 * Never throws; returns the transformed string with all separators preserved.
 */
export async function autoPrefixAttachments(value: string): Promise<string> {
  const tokens = value.split(/(\s+)/)
  const result: string[] = []

  for (const token of tokens) {
    // Skip tokens that are too short or already prefixed
    if (token.length < 2 || token.startsWith('@')) {
      result.push(token)
      continue
    }

    // Strip surrounding quotes (VS Code wraps dragged paths in '' or "")
    const stripped = token.replace(/^['"]|['"]$/g, '')

    // Only consider tokens that look like file paths
    if (!/^(\/|~\/|\.\/|\.\.\/)/.test(stripped)) {
      result.push(token)
      continue
    }

    const expanded = expandTilde(stripped)
    const resolved = resolve(process.cwd(), expanded)

    try {
      const stat = await import('fs/promises').then(m => m.stat(resolved))
      if (stat.isFile()) {
        result.push('@' + stripped)
      } else {
        // Path exists but is a directory — skip
        result.push(token)
      }
    } catch {
      // File not found or stat failed — skip
      result.push(token)
    }
  }

  return result.join('')
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.ts', '.js', '.tsx', '.jsx', '.json', '.yaml', '.yml',
  '.toml', '.sh', '.bash', '.css', '.html', '.xml', '.py', '.rb', '.go',
  '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.sql', '.graphql', '.proto',
  '.cfg', '.ini', '.env', '.csv', '.log',
])

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB

/**
 * Parse an input string for `@path/to/file` references, resolve them,
 * read and encode them. Returns the cleaned text (without @refs) and
 * the list of file attachments.
 *
 * Non-existent files referenced with `@` are left as-is in the text
 * (to avoid silently dropping typos).
 */
export async function parseAttachments(input: string): Promise<{
  cleaned: string
  attachments: FileAttachment[]
  errors: string[]
}> {
  const tokens = input.split(/(\s+)/)
  const results: FileAttachment[] = []
  const cleanedTokens: string[] = []
  const errors: string[] = []

  for (const token of tokens) {
    if (token.startsWith('@') && token.length > 1) {
      const rawPath = expandTilde(token.slice(1))
      const resolved = resolve(process.cwd(), rawPath)

      try {
        const stat = await import('fs/promises').then(m => m.stat(resolved))
        if (!stat.isFile()) {
          errors.push(`${token}: not a file (${resolved})`)
          cleanedTokens.push(token)
          continue
        }
        if (stat.size > MAX_FILE_SIZE) {
          errors.push(`${token}: file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 20 MB)`)
          cleanedTokens.push(token)
          continue
        }

        const attachment = await readFileAsAttachment(resolved, rawPath)
        if (attachment) {
          results.push(attachment)
        } else {
          errors.push(`${token}: unsupported file type`)
          cleanedTokens.push(token)
        }
      } catch {
        errors.push(`${token}: file not found (resolved to ${resolved})`)
        // Keep the token as-is in the text so typos aren't silently dropped
        cleanedTokens.push(token)
      }
    } else {
      cleanedTokens.push(token)
    }
  }

  const cleaned = cleanedTokens.join('')
  return { cleaned, attachments: results, errors }
}

/**
 * Read a file from disk and produce a FileAttachment.
 * Returns null for unsupported file types.
 */
async function readFileAsAttachment(filePath: string, displayPath: string): Promise<FileAttachment | null> {
  const ext = extname(filePath).toLowerCase()

  if (IMAGE_EXTENSIONS.has(ext)) {
    const mediaType = ext === '.jpg' ? 'image/jpeg'
      : ext === '.jpeg' ? 'image/jpeg'
      : ext === '.png' ? 'image/png'
      : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp'
      : ''
    if (!mediaType) return null

    const buffer = await readFile(filePath)
    return {
      path: displayPath,
      name: filePath.split('/').pop() ?? displayPath,
      base64: buffer.toString('base64'),
      mediaType,
      kind: 'image',
    }
  }

  if (ext === '.pdf') {
    const buffer = await readFile(filePath)
    return {
      path: displayPath,
      name: filePath.split('/').pop() ?? displayPath,
      base64: buffer.toString('base64'),
      mediaType: 'application/pdf',
      kind: 'pdf',
    }
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    const content = await readFile(filePath, 'utf-8')
    return {
      path: displayPath,
      name: filePath.split('/').pop() ?? displayPath,
      base64: Buffer.from(content, 'utf-8').toString('base64'),
      mediaType: 'text/plain',
      kind: 'text',
    }
  }

  // Unknown extension — try reading as text anyway
  try {
    const content = await readFile(filePath, 'utf-8')
    return {
      path: displayPath,
      name: filePath.split('/').pop() ?? displayPath,
      base64: Buffer.from(content, 'utf-8').toString('base64'),
      mediaType: 'text/plain',
      kind: 'text',
    }
  } catch {
    return null
  }
}

/**
 * Build Anthropic content blocks from a text prompt + file attachments.
 */
export function buildUserContent(
  text: string,
  attachments: FileAttachment[],
): Anthropic.MessageParam['content'] {
  if (attachments.length === 0) {
    return text
  }

  const blocks: Anthropic.ContentBlockParam[] = []

  // First: text block with the user's message (minus @references)
  blocks.push({ type: 'text', text })

  // Then: attachment blocks
  for (const att of attachments) {
    if (att.kind === 'image') {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: att.base64,
        },
      })
    } else if (att.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: att.base64,
        },
        title: att.name,
        context: text.length > 0 ? text : undefined,
      })
    } else {
      // Text files: send as text content block with a label
      const decoded = Buffer.from(att.base64, 'base64').toString('utf-8')
      blocks.push({
        type: 'text',
        text: `<file path="${att.path}">\n${decoded}\n</file>`,
      })
    }
  }

  return blocks
}
