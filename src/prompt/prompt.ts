import fs from 'fs'
import * as path from 'path'


export function getSystemPrompt(): string {
  const cwd = process.cwd()
  const basePrompt = fs.readFileSync(path.join(import.meta.dirname, 'systemprompt.md'), 'utf-8').trim()
  return `${basePrompt}\n\n当前工作目录：${cwd}`
}