/**
 * backgroundStorage — 后台任务结果持久化 + 轻量通知
 *
 * 设计意图：
 *   后台任务（fork sub-agent）完成后，结论文本可能很大（数千 tokens），
 *   直接推入 messages 数组会膨胀对话上下文，LLM 可能也不关心。
 *   解决方案：结论写文件，messages 只放一条轻量 XML 引用。
 *   LLM 按需通过 ReadTool 读取文件内容。
 *
 * 文件布局：
 *   .myagent/background/<taskId>.md
 *
 * 通知格式（XML tag，推入 messages）：
 *   <bg-task>
 *     <id>bg-xxx</id>
 *     <status>completed</status>
 *     <summary>一行摘要，告诉 LLM 后台做了什么</summary>
 *     <output>.myagent/background/bg-xxx.md</output>
 *   </bg-task>
 */

import fs from 'fs'
import path from 'path'

const BG_DIR = path.join(process.cwd(), '.myagent', 'background')

/** 确保 background 目录存在 */
function ensureBgDir(): void {
  if (!fs.existsSync(BG_DIR)) {
    fs.mkdirSync(BG_DIR, { recursive: true })
  }
}

let taskCounter = 0

/** 生成唯一的后台任务 ID */
export function generateBgTaskId(): string {
  taskCounter++
  const ts = Date.now().toString(36)
  const seq = taskCounter.toString(36)
  return `bg-${ts}-${seq}`
}

/**
 * 将后台任务结论写入文件。
 * @returns 输出文件的绝对路径
 */
export function saveBackgroundResult(
  taskId: string,
  description: string,
  conclusion: string,
): string {
  ensureBgDir()
  const filePath = path.join(BG_DIR, `${taskId}.md`)
  const content = [
    `# Background Task: ${description}`,
    `> Completed at ${new Date().toISOString()}`,
    '',
    conclusion,
  ].join('\n')
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/**
 * 构造轻量 XML 通知文本（推入 messages 数组）。
 * 大小通常 < 300 字节，不膨胀上下文。
 *
 * @param taskId  后台任务 ID
 * @param status  completed | failed
 * @param summary 一行摘要，LLM 据此决定是否要读文件
 * @param outputPath 输出文件路径（相对 cwd，LLM 可以直接传给 ReadTool）
 * @param error   失败时的错误信息（可选，仅 status=failed 时使用）
 */
export function buildBgNotification(
  taskId: string,
  status: 'completed' | 'failed',
  summary: string,
  outputPath: string,
  error?: string,
): string {
  const lines: string[] = [
    `<bg-task>`,
    `  <id>${escapeXml(taskId)}</id>`,
    `  <status>${status}</status>`,
    `  <summary>${escapeXml(summary)}</summary>`,
    `  <output>${escapeXml(outputPath)}</output>`,
  ]
  if (error) {
    lines.push(`  <error>${escapeXml(error)}</error>`)
  }
  lines.push(`</bg-task>`)
  return lines.join('\n')
}

/**
 * 清理过期的后台结果文件（清理早于 maxAgeMs 的文件）。
 * 在进程启动时调用一次即可。
 */
export function cleanOldResults(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    if (!fs.existsSync(BG_DIR)) return
    const now = Date.now()
    for (const name of fs.readdirSync(BG_DIR)) {
      const filePath = path.join(BG_DIR, name)
      const stat = fs.statSync(filePath)
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath)
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
