import fs from 'fs'
import path from 'path'
import os from 'os'
import { cwd } from 'process'

export type MemoryCategory = 'profile' | 'project' | 'feedback' | 'reference' | 'index'

function getProjectSlug(): string {
  return cwd().replace(/\//g, '-')
}

function getMemoryDir(): string {
  return path.join(os.homedir(), '.myagent', 'memory', getProjectSlug())
}

export function getMemoryFiles(): Record<MemoryCategory, string> {
  const dir = getMemoryDir()
  return {
    profile:  path.join(dir, 'profile.md'),
    project:  path.join(dir, 'project.md'),
    feedback: path.join(dir, 'feedback.md'),
    reference: path.join(dir, 'reference.md'),
    index:    path.join(dir, 'INDEX.md'),
  }
}

/** 返回记忆整理的 prompt 指令 */
export function getMemoryPrompt(): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'prompt.md'), 'utf-8').trim()
}

function ensureDir(): void {
  fs.mkdirSync(getMemoryDir(), { recursive: true })
}

/** 读取指定分类文件的内容 */
export function readCategory(category: MemoryCategory): string {
  ensureDir()
  const filePath = getMemoryFiles()[category]
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '')
    return ''
  }
  return fs.readFileSync(filePath, 'utf-8').trim()
}

/** 写入指定分类文件 */
export function writeCategory(category: MemoryCategory, content: string): void {
  ensureDir()
  fs.writeFileSync(getMemoryFiles()[category], content)
}

/** 读取所有分类（除 index 外）的内容，返回一个对象 */
export function readAllCategories(): Record<Exclude<MemoryCategory, 'index'>, string> {
  const result = {} as Record<Exclude<MemoryCategory, 'index'>, string>
  const categories = ['profile', 'project', 'feedback', 'reference'] as const
  for (const cat of categories) {
    result[cat] = readCategory(cat)
  }
  return result
}
