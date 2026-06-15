# Token 优化计划

> 状态：✅ 全部完成  
> 更新：2025-07-16

## Phase 1 ✅ 已完成

| 变更 | 文件 | 节省 | 说明 |
|------|------|------|------|
| tools cache_control | `src/utils/runagent.ts` | ~1,500-3,500t/请求 | Claude：tools 进 prompt cache；DeepSeek 自动跳过 |
| 精简 agent tool description | `src/tools/agenttool.ts` | ~800t/请求 | system prompt 已有完整描述，tool 只需列 agent 名 |
| 移除 AgentAttachment | `src/agents/registry.ts` | 零（死代码） | bootstrap 末尾 `attachmentQueue.clear()` 本就清掉了它们 |

---

## Phase 2：DeepSeek prefix cache 稳定性

**问题**：DeepSeek 使用 prefix-based KV cache（非 Anthropic 的标记式 `cache_control`）。当前 memory recall 结果混在 system prompt 的 dynamic segment 中，每次请求 memory 内容不同 → 整个 prefix 失效。

**现状**：
```
system: [stable ~2300t] + [dynamic: memory + skills]
          ↑ cached         ↑ 每次变化 → 破坏 prefix
```

**目标**：
```
system: [stable ~2300t]           ← 完全稳定，DeepSeek 可缓存
user message 1: [memory recall]    ← 作为第一条 user message 注入
user message 2: [用户实际输入]
```

**方案**：
1. 修改 `buildSystemSegments()` — memory 不再进入 dynamic segment
2. 在 `runTurn()` 开头，将 memory 作为第一条 user message 而非 system text 注入
3. skills fragment 同理（或保留在 system，因为 switch 频率低）

**文件**：
- `src/bootstrap.ts` — `buildSystemSegments()`
- `src/turn.ts` — `runTurn()` 的 memory 注入位置

**预估收益**：DeepSeek 每次请求 system prefix 命中 cache（~2300t → cache read），节省 ~2,000t/请求

**风险**：低。memory 从 system 挪到 message 不应影响 LLM 行为（语义相同，位置不同）

---

## Phase 3：Tool result 截断

**问题**：`read_file` 返回 10KB 文件、`bash` 输出大量 stdout 时，结果原文进入 messages。microcompact 只清除 3 轮前的，最近 3 轮超大 result 不受限制。

**现状**：
```
messages: [... tool_use, tool_result(10KB read_file), tool_use, tool_result(5KB bash), ...]
             ↑ microcompact 只动 3 轮前的            ↑ 这些都是"最近 3 轮"，不受限
```

**方案**：
1. 在 `executeToolsWithParallelism` 中，对 tool result 做 per-call 截断：
   - `read_file`/`bash`/`web_fetch`：保留头 2000 字符 + 尾 500 字符 + 省略行数
   - 其他工具：不做截断
2. 截断前在 stderr 输出 `[truncate] tool_name: 原始长度→截断后长度`，方便 debug

**文件**：
- `src/utils/runagent.ts` — `executeToolsWithParallelism()`

**预估收益**：防止单轮 context 爆炸，不是固定数值节省，而是长尾保护

**风险**：截断可能丢失 LLM 需要的信息。需谨慎选择截断阈值，保留头尾确保关键信息不丢。

---

## Phase 4：剩余优化项

### 4a. 精简 systemprompt.md（~700t 节省）

当前 ~1500t，可压缩到 ~800t。具体删减项：

| 可删除/压缩 | 原因 |
|-------------|------|
| Team 协作 5 步流程 | 操作手册性质，改为 tool description 中展开 |
| 任务拆解章节 | meta 说明，LLM 不需要每次被提醒 |
| Advisor 5 条场景列表 | 保留一句话核心原则即可 |
| 修改与执行细节 | 压缩为 2-3 句 |

**保留项**：角色定义、沟通规范（中文/画图/给缺点）、advisor 触发条件、验证规范

**文件**：`src/prompt/systemprompt.md`

### 4b. Agent tool passthrough schema 精简（~300-500t）

当前 `agenttool.ts` 的 `input_schema` getter 将所有 agent 自定义字段合并进同一个 schema，导致 property 数量膨胀（14 agent × 2-5 fields）。可改为 discriminated union 或缩减 property descriptions。

**文件**：`src/tools/agenttool.ts`

### 4c. 降低 compact 阈值

当前 `MICRO_COMPACT_TOKEN_THRESHOLD = 80K`、`COMPACT_TOKEN_THRESHOLD = 150K`。对于 DeepSeek 64K 窗口偏高了。

建议：
- MICRO: 80K → 40K
- COMPACT: 150K → 55K

**文件**：`src/utils/compact.ts`

### 4d. Microcompact 阶段截断超长 assistant message

当前 microcompact 只清除 tool result，不处理 assistant 文本回复。如果 LLM 每次回复都很详细（长代码块），assistant messages 持续增长直到 150K 才触发 compact。

建议：对超过 2000 字符的 assistant text，保留头 500 + 尾 200 + 省略标记。

**文件**：`src/utils/compact.ts`

---

## 汇总

| Phase | 项目 | 预估节省 | 风险 | 工作量 |
|-------|------|---------|------|--------|
| ✅ 1 | tools cache + agent desc + AgentAttachment | ~1,800t/请求 | 低 | 已完成 |
| 2 | DeepSeek prefix cache | ~2,000t/请求 | 低 | 中 |
| 3 | tool result 截断 | 长尾保护 | 中 | 中 |
| 4a | 精简 systemprompt.md | ~700t/请求 | 低 | 低 |
| 4b | passthrough schema 精简 | ~300-500t/请求 | 低 | 低 |
| 4c | 降低 compact 阈值 | 延迟收益 | 极低 | 极低 |
| 4d | microcompact 截断 assistant | 长尾保护 | 低 | 低 |

**Phase 2+3+4 全部完成后**：预计每次请求固定开销从 ~5,300t 降至 ~2,000t（Claude）/ ~2,500t（DeepSeek），加上 cache 命中后实际计费 <500t。
