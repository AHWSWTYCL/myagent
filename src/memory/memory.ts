import fs from 'fs'
import path from 'path'
import os from 'os'

const MEMORY_DIR = path.join(os.homedir(), '.myagent', 'memory')
export const MEMORY_FILE_PATH = path.join(MEMORY_DIR, 'memory.md')

export function getMemoryPrompt(): string {
    return fs.readFileSync(path.join(import.meta.dirname, 'prompt.md'), 'utf-8').trim()
}

export function getUserMessage(): string {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
    if (!fs.existsSync(MEMORY_FILE_PATH)) {
        fs.writeFileSync(MEMORY_FILE_PATH, '')
    }
    return fs.readFileSync(MEMORY_FILE_PATH, 'utf-8').trim()
}