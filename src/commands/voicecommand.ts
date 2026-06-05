/**
 * VoiceCommand — 控制 LLM 消息的语音播报
 *
 * 子命令：
 *   /voice on              — 开启播报
 *   /voice off             — 关闭播报
 *   /voice stop            — 立即打断当前播报、清空队列
 *   /voice voice <name>    — 切换音色（macOS `say -v ?` 可看全部音色）
 *   /voice rate <wpm>      — 调整语速（每分钟单词数，50-500）
 *   /voice say <text>      — 立即朗读一段文本（用于试听新音色 / 语速）
 *   /voice                 — 显示当前状态
 */

import { Command } from './command.js'
import { ttsService } from '../voice/tts.js'

export class VoiceCommand extends Command {
  get name(): string {
    return 'voice'
  }

  get description(): string {
    return '语音播报开关：on / off / stop / voice <name> / rate <wpm> / say <text>'
  }

  get usage(): string {
    return '/voice [on|off|stop|voice <name>|rate <wpm>|say <text>]'
  }

  async execute(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase()
    const rest = args.slice(1)

    switch (sub) {
      case undefined:
      case '':
      case 'status':
        return this.cmdStatus()
      case 'on':
        ttsService.setEnabled(true)
        console.log('[voice] 已开启 — 之后每条 LLM 回复都会朗读。')
        return
      case 'off':
        ttsService.setEnabled(false)
        console.log('[voice] 已关闭。')
        return
      case 'stop':
        ttsService.stop()
        console.log('[voice] 已打断当前播报。')
        return
      case 'voice':
        return this.cmdSetVoice(rest)
      case 'rate':
        return this.cmdSetRate(rest)
      case 'say':
        return this.cmdSayNow(rest)
      default:
        console.log(`未知子命令: ${sub}`)
        console.log(`用法: ${this.usage}`)
    }
  }

  private cmdStatus(): void {
    const enabled = ttsService.isEnabled()
    const voice = ttsService.getVoice() ?? '系统默认'
    const rate = ttsService.getRate() ?? '默认'
    console.log(`[voice] 状态: ${enabled ? 'ON' : 'OFF'}   音色: ${voice}   语速: ${rate}`)
    if (process.platform !== 'darwin') {
      console.log('[voice] ⚠ 当前 TTS 仅支持 macOS（依赖 `say` 命令）。')
    }
    console.log(`用法: ${this.usage}`)
    console.log('查看可用音色: 在终端运行 `say -v ?`')
  }

  private cmdSetVoice(rest: string[]): void {
    if (rest.length === 0) {
      console.log('用法: /voice voice <name>   例如 /voice voice Tingting')
      console.log('清除音色: /voice voice default')
      return
    }
    const name = rest.join(' ')
    if (name.toLowerCase() === 'default' || name === '-') {
      ttsService.setVoice(undefined)
      console.log('[voice] 音色已恢复为系统默认。')
      return
    }
    ttsService.setVoice(name)
    console.log(`[voice] 音色已切换为: ${name}`)
  }

  private cmdSetRate(rest: string[]): void {
    if (rest.length === 0) {
      console.log('用法: /voice rate <wpm>   例如 /voice rate 220')
      console.log('恢复默认: /voice rate default')
      return
    }
    const arg = rest[0]
    if (arg.toLowerCase() === 'default' || arg === '-') {
      ttsService.setRate(undefined)
      console.log('[voice] 语速已恢复为默认。')
      return
    }
    const wpm = Number(arg)
    if (!Number.isFinite(wpm)) {
      console.log(`[voice] 无效的语速: "${arg}"（需为数字）`)
      return
    }
    try {
      ttsService.setRate(wpm)
      console.log(`[voice] 语速已设置为 ${wpm} wpm。`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[voice] ${msg}`)
    }
  }

  private cmdSayNow(rest: string[]): void {
    const text = rest.join(' ').trim()
    if (!text) {
      console.log('用法: /voice say <text>')
      return
    }
    if (!ttsService.isEnabled()) {
      ttsService.setEnabled(true)
      console.log('[voice] 自动开启 — 试听完成后可用 /voice off 关闭。')
    }
    ttsService.speak(text)
  }
}
