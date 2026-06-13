/**
 * test_mcp.ts — 独立测试 VSCode 插件 MCP Server
 *
 * 模拟 myagent 作为 MCP Client 连接 VSCode 插件：
 *   1. initialize 握手
 *   2. tools/list 获取工具
 *   3. tools/call 调用 getOpenFiles（同步工具）
 *
 * 注意：LSP 工具（goToDefinition/hover 等）依赖 vscode API，
 * 无法在 VSCode 外部测试。此处测试协议层和同步 IDE 工具。
 *
 * 用法: cd vscode-extension && npx tsx test_mcp.ts
 * 前置: VSCode 已启动，插件已激活（状态栏显示 MyAgent:{port}）
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const PORT_FILE = path.join(os.homedir(), '.myagent', 'vscode-mcp.json')

// ── 读取端口 ──────────────────────────────────────────────────────────────────

function getPort(): number {
  if (!fs.existsSync(PORT_FILE)) {
    console.error('❌ 端口文件不存在:', PORT_FILE)
    console.error('   请确保 VSCode 已启动且 myagent-lsp 插件已激活')
    process.exit(1)
  }
  const { port } = JSON.parse(fs.readFileSync(PORT_FILE, 'utf-8'))
  return port
}

// ── MCP Client (简化版) ──────────────────────────────────────────────────────

let _id = 1
function nextId(): number { return _id++ }

function sendRequest(host: string, port: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId()
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    const req = http.request({
      hostname: host,
      port,
      path: '/message',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => data += chunk.toString('utf-8'))
      res.on('end', () => {
        try {
          const response = JSON.parse(data)
          resolve(response)
        } catch (err) {
          reject(new Error(`Parse error: ${data.slice(0, 200)}`))
        }
      })
    })

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── 测试 ──────────────────────────────────────────────────────────────────────

async function main() {
  const port = getPort()
  const HOST = 'localhost'
  console.log(`🔌 连接 VSCode MCP Server: http://${HOST}:${port}`)

  // Test 1: initialize
  console.log('\n📡 Test 1: initialize')
  const initResult = await sendRequest(HOST, port, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    clientInfo: { name: 'myagent-test', version: '1.0.0' },
  }) as any
  console.log('   result:', JSON.stringify(initResult.result, null, 2))

  if (initResult.error) {
    console.error('❌ initialize 失败:', initResult.error)
    process.exit(1)
  }
  console.log('✅ initialize 成功')

  // Test 2: tools/list
  console.log('\n📡 Test 2: tools/list')
  const toolsResult = await sendRequest(HOST, port, 'tools/list') as any
  if (toolsResult.error) {
    console.error('❌ tools/list 失败:', toolsResult.error)
    process.exit(1)
  }

  const tools = toolsResult.result?.tools ?? []
  console.log(`   返回 ${tools.length} 个工具:`)
  for (const t of tools) {
    console.log(`     - ${t.name}: ${t.description.slice(0, 60)}...`)
  }
  console.log('✅ tools/list 成功')

  // Test 3: tools/call — getOpenFiles (同步工具，不依赖 vscode API)
  console.log('\n📡 Test 3: tools/call getOpenFiles')
  const callResult = await sendRequest(HOST, port, 'tools/call', {
    name: 'getOpenFiles',
    arguments: {},
  }) as any

  if (callResult.error) {
    console.log(`   错误 (预期，VSCode 中可能无打开文件或非 file scheme): ${callResult.error.message}`)
  } else {
    const text = callResult.result?.content?.[0]?.text ?? ''
    console.log(`   结果: ${text.slice(0, 200)}`)
  }
  console.log('✅ tools/call 完成')

  // Test 4: tools/call — getActiveFile
  console.log('\n📡 Test 4: tools/call getActiveFile')
  const activeResult = await sendRequest(HOST, port, 'tools/call', {
    name: 'getActiveFile',
    arguments: {},
  }) as any

  if (activeResult.error) {
    console.log(`   错误 (预期): ${activeResult.error.message}`)
  } else {
    console.log(`   结果: ${activeResult.result?.content?.[0]?.text?.slice(0, 200) ?? '(empty)'}`)
  }
  console.log('✅ tools/call 完成')

  // Test 5: tools/call — getSelection
  console.log('\n📡 Test 5: tools/call getSelection')
  const selResult = await sendRequest(HOST, port, 'tools/call', {
    name: 'getSelection',
    arguments: {},
  }) as any

  if (selResult.error) {
    console.log(`   错误 (预期): ${selResult.error.message}`)
  } else {
    console.log(`   结果: ${selResult.result?.content?.[0]?.text?.slice(0, 200) ?? '(empty)'}`)
  }
  console.log('✅ tools/call 完成')

  // Test 6: LSP 工具 — 如果 VSCode 中有打开的文件
  console.log('\n📡 Test 6: tools/call goToDefinition')
  const lspResult = await sendRequest(HOST, port, 'tools/call', {
    name: 'goToDefinition',
    arguments: {
      filePath: 'src/agent.ts',
      line: 23,
      character: 10,
    },
  }) as any

  if (lspResult.error) {
    console.log(`   错误: ${lspResult.error.message}`)
  } else {
    console.log(`   结果: ${lspResult.result?.content?.[0]?.text?.slice(0, 300) ?? '(empty)'}`)
  }
  console.log('✅ LSP 工具调用完成')

  console.log('\n🎉 所有测试完成！')
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message)
  process.exit(1)
})
