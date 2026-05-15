import fs from 'fs'
import path from 'path'
import { cwd } from 'process'

export function getMemoryPrompt(): string {
    return fs.readFileSync(path.join(import.meta.dirname, 'prompt.md'), 'utf-8').trim()
}

export function getUserMessage(): string {
    // check exist
    const userMessagePath = path.join(cwd(), 'memory.md')
    if (!fs.existsSync(userMessagePath)) {
        fs.writeFileSync(userMessagePath, '')
    }
    return fs.readFileSync(userMessagePath, 'utf-8').trim()
}