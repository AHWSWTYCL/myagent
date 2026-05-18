import fs from 'fs'
import path from 'path'
import os from 'os'

const MEMORY_DIR = path.join(os.homedir(), '.myagent', 'memory')

/** 各分类对应的文件路径 */
export const MEMORY_FILES = {
  profile: path.join(MEMORY_DIR, 'profile.md'),
  project: path.join(MEMORY_DIR, 'project.md'),
  feedback: path.join(MEMORY_DIR, 'feedback.md'),
  reference: path.join(MEMORY_DIR, 'reference.md'),
  index: path.join(MEMORY_DIR, 'INDEX.md'),
} as const

export type MemoryCategory = keyof typeof MEMORY_FILES

/** 返回记忆整理的 prompt 指令 */
export function getMemoryPrompt(): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'prompt.md'), 'utf-8').trim()
}

function ensureDir(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
}

/** 读取指定分类文件的内容 */
export function readCategory(category: MemoryCategory): string {
  ensureDir()
  const filePath = MEMORY_FILES[category]
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '')
    return ''
  }
  return fs.readFileSync(filePath, 'utf-8').trim()
}

/** 写入指定分类文件 */
export function writeCategory(category: MemoryCategory, content: string): void {
  ensureDir()
  fs.writeFileSync(MEMORY_FILES[category], content)
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
