import fs from 'fs'
import { fileURLToPath } from 'url'
import * as path from 'path'
import { toolName as readName, toolDescription as readDesc } from '../tools/readprompt.js'
import { toolName as writeName, toolDescription as writeDesc } from '../tools/writeprompt.js'
import { toolName as bashName, toolDescription as bashDesc } from '../tools/bashprompt.js'
import { toolName as listDirName, toolDescription as listDirDesc } from '../tools/listdirprompt.js'
import { toolName as grepName, toolDescription as grepDesc } from '../tools/grepprompt.js'
import { toolName as globName, toolDescription as globDesc } from '../tools/globprompt.js'
import { toolName as editName, toolDescription as editDesc } from '../tools/editprompt.js'
import { toolName as fetchName, toolDescription as fetchDesc } from '../tools/fetchprompt.js'
import { toolName as webSearchName, toolDescription as webSearchDesc } from '../tools/websearchprompt.js'
import { toolName as memoryName, toolDescription as memoryDesc } from '../tools/memoryprompt.js'
import { toolName as choiceName, toolDescription as choiceDesc } from '../tools/choiceprompt.js'
import { toolName as askName, toolDescription as askDesc } from '../tools/askprompt.js'
import { toolName as agentName, toolDescription as agentDesc } from '../tools/agentprompt.js'
import { toolName as useSkillName, toolDescription as useSkillDesc } from '../tools/useskillprompt.js'
import { toolName as invokeSkillName, toolDescription as invokeSkillDesc } from '../tools/invokeskillprompt.js'
import { toolName as skillWriteName, toolDescription as skillWriteDesc } from '../tools/skillwriteprompt.js'
import { toolName as todoPlanName, toolDescription as todoPlanDesc } from '../tools/todoplannerprompt.js'
import { toolName as todoUpdateName, toolDescription as todoUpdateDesc } from '../tools/todoupdateprompt.js'
import { toolName as createTeamName, toolDescription as createTeamDesc } from '../tools/createteamprompt.js'
import { toolName as sendMailName, toolDescription as sendMailDesc } from '../tools/sendmailprompt.js'
import { toolName as checkMailName, toolDescription as checkMailDesc } from '../tools/checkmailprompt.js'

const TOOL_PROMPTS: [string, string][] = [
  [bashName, bashDesc],
  [readName, readDesc],
  [writeName, writeDesc],
  [editName, editDesc],
  [listDirName, listDirDesc],
  [grepName, grepDesc],
  [globName, globDesc],
  [webSearchName, webSearchDesc],
  [fetchName, fetchDesc],
  [memoryName, memoryDesc],
  [choiceName, choiceDesc],
  [askName, askDesc],
  [agentName, agentDesc],
  [useSkillName, useSkillDesc],
  [invokeSkillName, invokeSkillDesc],
  [skillWriteName, skillWriteDesc],
  [todoPlanName, todoPlanDesc],
  [todoUpdateName, todoUpdateDesc],
  [createTeamName, createTeamDesc],
  [sendMailName, sendMailDesc],
  [checkMailName, checkMailDesc],
]

/** 生成"可用工具"章节的 markdown 文本。 */
export function getToolsSection(): string {
  const lines = ['## 可用工具', '']
  for (const [name, desc] of TOOL_PROMPTS) {
    lines.push(`### ${name}`)
    lines.push(desc)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * 构建完整 system prompt。
 * @param agentSection 可选的 sub-agent 描述段落（由 AgentRegistry.describeForPrompt() 生成）
 */
export function getSystemPrompt(agentSection?: string): string {
  const cwd = process.cwd()
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const basePrompt = fs.readFileSync(
    path.join(dir, 'systemprompt.md'),
    'utf-8',
  ).trim()

  const parts: string[] = [basePrompt]
  parts.push('')
  parts.push(getToolsSection())

  if (agentSection) {
    parts.push('')
    parts.push(agentSection)
  }

  parts.push('')
  parts.push(`当前工作目录：${cwd}`)

  return parts.join('\n')
}
