/**
 * LSP 完整调用链测试 — 验证 goToDefinition 在 turn.ts 中的 runTurn 函数
 */
import { createLSPServerManager } from '../lsp/LSPServerManager.js'
import { fileStateCache } from '../utils/fileStateCache.js'
import path from 'path'
import fs from 'fs'

async function main() {
  console.log('═══ LSP Integration Test ═══\n')
  
  const manager = createLSPServerManager()
  
  try {
    // 测试文件：turn.ts（runTurn 定义在此）
    const testFile = path.resolve('src/turn.ts')
    const content = fs.readFileSync(testFile, 'utf-8')
    fileStateCache.set(testFile, { content, timestamp: fs.statSync(testFile).mtimeMs })
    
    // 找 "export async function runTurn" 的位置
    const lines = content.split('\n')
    let targetLine = -1, targetChar = -1
    for (let i = 0; i < lines.length; i++) {
      // runTurn 定义可能在 "export async function runTurn"
      const idx = lines[i]!.indexOf('runTurn')
      if (idx !== -1) {
        targetLine = i
        targetChar = idx
        break
      }
    }
    
    if (targetLine === -1) {
      console.log('❌ runTurn not found')
      return
    }
    
    console.log(`1. Found "runTurn" at line ${targetLine + 1}, char ${targetChar + 1}`)
    console.log(`   > ${lines[targetLine]!.trim().slice(0, 80)}`)
    
    // 启动 LSP + 同步文件
    console.log(`\n2. Starting ts-ls...`)
    await manager.ensureStarted(testFile)
    console.log('   ✅ Server started')
    
    console.log(`3. didOpen turn.ts...`)
    await manager.openFile(testFile)
    console.log('   ✅ File synced')
    
    // goToDefinition — 在 agent.ts 中查 runTurn 的引用，看它是否指向 turn.ts
    const agentFile = path.resolve('src/agent.ts')
    const agentContent = fs.readFileSync(agentFile, 'utf-8')
    fileStateCache.set(agentFile, { content: agentContent, timestamp: fs.statSync(agentFile).mtimeMs })
    const agentLines = agentContent.split('\n')
    let importLine = -1, importChar = -1
    for (let i = 0; i < agentLines.length; i++) {
      const idx = agentLines[i]!.indexOf('runTurn')
      if (idx !== -1) {
        importLine = i; importChar = idx
        break
      }
    }
    
    console.log(`\n4. Testing goToDefinition from agent.ts line ${importLine + 1}, char ${importChar + 1}`)
    console.log(`   > ${agentLines[importLine]!.trim()}`)
    
    await manager.openFile(agentFile)
    const uri = `file://${agentFile}`
    const result = await manager.sendRequest<any>(
      agentFile,
      'textDocument/definition',
      { textDocument: { uri }, position: { line: importLine, character: importChar } },
    )
    
    if (result && (Array.isArray(result) ? result.length > 0 : true)) {
      const loc = Array.isArray(result) ? result[0] : result
      console.log(`   ✅ Definition found!`)
      const defPath = loc.uri.replace('file://', '')
      console.log(`   → ${defPath}:${(loc.range.start.line || 0) + 1}:${(loc.range.start.character || 0) + 1}`)
    } else {
      console.log('   ⚠️ No definition found')
    }
    
    console.log('\n═══ Test Complete ═══')
  } catch (err) {
    console.error('❌ Test failed:', err)
  } finally {
    await manager.shutdown()
    setTimeout(() => process.exit(0), 100)
  }
}

main()
