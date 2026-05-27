import { spawn } from 'child_process'
import { Tool, type ToolRenderHeader } from './tool'

const TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 50_000

export class GrepTool extends Tool {

    get name(): string {
        return 'grep'
    }

    get description(): string {
        return 'Search for a pattern in files using grep. Returns matching lines with file names and line numbers.'
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regular expression or literal string to search for' },
                path: { type: 'string', description: 'File or directory to search in (default: current working directory)' },
                recursive: { type: 'boolean', description: 'Search recursively in directories (default: true)' },
                case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
                include: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.ts"' },
            },
            required: ['pattern'],
        }
    }

    get parallelSafe(): boolean { return true }

    get isExplorationTool(): boolean { return true }

    renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
        return { label: 'Grep', args: String(input.pattern ?? '') }
    }

    renderToolResult(output: string, isError: boolean): string[] {
        if (isError) return Tool.summarize(output, true)
        const lines = output.trim() ? output.trim().split('\n') : []
        return lines.length === 0
            ? ['No matches']
            : [`Found ${lines.length} match${lines.length === 1 ? '' : 'es'}`]
    }

    async checkPermission(_args: Record<string, unknown>): Promise<import('./tool.js').ToolPermissionResult> {
        return { action: 'continue' }
    }

    async execute(args: any, signal?: AbortSignal): Promise<string> {
        const { pattern, path: searchPath, recursive = true, case_insensitive = false, include } = args

        const flags: string[] = ['-n'] // line numbers
        if (recursive) flags.push('-r')
        if (case_insensitive) flags.push('-i')
        if (include) flags.push(`--include=${include}`)

        const target = searchPath ?? '.'
        const cmd = `grep ${flags.join(' ')} ${JSON.stringify(pattern)} ${JSON.stringify(target)}`

        return runGrepAsync(cmd, signal)
    }
}

function runGrepAsync(cmd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.slice(0, MAX_OUTPUT_BYTES - stdout.length)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.slice(0, MAX_OUTPUT_BYTES - stderr.length)
      }
    })

    const killProcessGroup = (sig: NodeJS.Signals) => {
      try { process.kill(-child.pid!, sig) } catch { /* already dead */ }
    }

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      killProcessGroup('SIGTERM')
    }, TIMEOUT_MS)

    const onAbort = () => {
      clearTimeout(timeout)
      killProcessGroup('SIGTERM')
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (err) => {
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(`Error: ${err.message}`)
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', onAbort)

      if (timedOut) {
        resolve(`Timed out after ${TIMEOUT_MS / 1000}s:\n${stdout || '(no output)'}`)
        return
      }
      // grep exits with code 1 when no matches — not an error
      if (code === 1) {
        resolve('No matches found.')
        return
      }
      if (code !== 0) {
        resolve(`Exit code ${code ?? '?'}:\n${stderr || stdout || '(no output)'}`)
        return
      }
      resolve(stdout.trim() || 'No matches found.')
    })
  })
}
