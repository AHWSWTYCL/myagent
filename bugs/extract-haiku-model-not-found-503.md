# 记忆抽取模块调用 claude-haiku-4-5 在代理渠道返回 503 model_not_found 导致记忆功能完全失效

> 状态: OPEN | 严重度: P2 | 作者: bug_intake agent | 日期: 2025-05-26

## 1. 现象（Symptom）

**用户实际看到的**：每轮对话结束后，控制台打印如下错误：

```
[extract] Error: Error: 503 {"error":{"code":"model_not_found","message":"No available channel for model claude-haiku-4-5 under group Claude官稳 (distributor) (request id: 202605260303451648292848268d9d6xrQQzid5)","type":"new_api_error"}}
```

**期望看到的**：对话内容中符合触发条件的信息被抽取并写入记忆文件，后续对话可以召回。

**两者差异**：记忆条目从未被写入，`memory.md` 始终为空（或不增长）。记忆抽取功能自项目搭建起就完全失效。

---

## 2. 复现步骤

1. 在 `~/.claude/settings.json` 的 `env` 中配置 `ANTHROPIC_BASE_URL` 指向第三方代理渠道（Claude官稳 distributor）
2. 启动 agent（`npm run dev` 或等效命令）
3. 在 TUI 中输入任意一条对话内容，等待 agent 回复完成
4. 对话结束后，`agent.ts` 中的 `extractMemoryFromTurn` 被异步调用，内部向代理渠道请求 `claude-haiku-4-5` 模型

**实际结果**：代理渠道返回 HTTP 503，错误码 `model_not_found`，`extractMemoryFromTurn` 的 catch 块打印错误后返回空数组，记忆不写入。

**期望结果**：记忆抽取调用成功，符合条件的信息被写入对应分类的 memory 文件。

---

## 3. 复现率与触发条件

- **复现率**：100%，每轮对话结束后必然触发
- **触发条件**：
  - 使用第三方代理渠道（`ANTHROPIC_BASE_URL` 指向非 Anthropic 官方端点）
  - 代理渠道的可用模型列表中不包含 `claude-haiku-4-5`
  - 任意一轮对话结束（`extractMemoryFromTurn` 在每轮 `runTurn` 末尾被无条件调用）
- **不复现的对照**：
  - 主流程使用的 `claude-sonnet-4-6` 在同一代理渠道下调用正常，说明问题仅限于 `claude-haiku-4-5` 这个模型名在该渠道不可用，而非整个渠道或认证失败
  - 若代理渠道支持 `claude-haiku-4-5`，或直连 Anthropic 官方 API，预期不复现（**未经用户验证，为推断**）

---

## 4. 环境

- **OS / 浏览器 / 设备**：未收集（用户未提供，待补充）
- **版本 / commit / 部署**：未收集（用户未提供，待补充）
- **API 接入方式**：第三方代理渠道（new-api / one-api 类分发服务），group 名为 `Claude官稳 (distributor)`
- **数据规模 / 账号特征**：不限，任意对话内容均触发
- **首次出现时间**：项目搭建起即存在，从未正常工作过

---

## 5. 影响范围与严重度

- **谁受影响**：所有使用第三方代理渠道且该渠道不支持 `claude-haiku-4-5` 的用户
- **影响功能**：记忆抽取（`extractMemoryFromTurn`）和记忆合并（`consolidateCategory`）均失效，长期记忆功能完全不可用
- **数据是否受损**：无数据损坏，只是记忆条目从未写入，属于功能缺失而非数据破坏
- **是否有 workaround**：无明确 workaround；主流程对话（claude-sonnet-4-6）不受影响，用户可继续使用 agent，但记忆功能形同虚设
- **严重度判定理由**：P2 —— 记忆是 agent 的核心能力之一，完全失效影响产品价值；但主流程不崩溃、不丢失用户数据，且错误被静默处理不影响当前会话体验，故不升至 P1

---

## 6. 相关线索

- **报错信息**：
  ```
  [extract] Error: Error: 503 {"error":{"code":"model_not_found","message":"No available channel for model claude-haiku-4-5 under group Claude官稳 (distributor) (request id: 202605260303451648292848268d9d6xrQQzid5)","type":"new_api_error"}}
  ```
- **相关日志**：错误由 `src/memory/extract.ts` 第 `console.error('[extract] Error: ${err}')` 行打印，经 `agent.ts` 中 `console.log` 重定向后通过 TUI bridge 输出
- **网络请求 / 响应**：HTTP 503，错误类型 `new_api_error`，代理渠道侧返回，非 Anthropic 官方错误格式
- **怀疑相关的最近改动**：无（问题从项目初始即存在）
- **摸底时发现可能涉及的模块/文件**（线索，非结论）：
  - `src/memory/extract.ts`：`EXTRACT_MODEL = 'claude-haiku-4-5'` 硬编码在第 37 行，`extractMemoryFromTurn` 和 `consolidateCategory` 均使用此常量
  - `src/agent.ts`：在 `runTurn` 末尾异步调用 `extractMemoryFromTurn`，catch 后仅打印错误，不重试、不降级
  - `src/client.ts`：`withRetry` 工具函数存在但未被 `extract.ts` 使用；`isRetryable` 对 5xx 返回 true，理论上 503 可重试，但 extract 调用路径未接入此逻辑
  - `src/config.ts`：`ANTHROPIC_BASE_URL` 从 `~/.claude/settings.json` 读取，extract 模块通过 `createClient()` 复用同一配置，因此受代理渠道模型限制影响

---

## 7. 假设与未决问题

- **假设**：
  - 代理渠道（Claude官稳）的可用模型列表中不包含 `claude-haiku-4-5` 这个确切的模型名，但可能支持其他 haiku 系列模型名（如 `claude-haiku-3-5` 或 `claude-3-haiku-20240307`）—— **未经验证**
  - 若将 `EXTRACT_MODEL` 改为代理渠道支持的模型名，记忆功能可恢复 —— **未经验证，留给 explore 确认**
  - `consolidateCategory` 同样使用 `EXTRACT_MODEL`，因此记忆合并功能也同样失效，但由于记忆条目从未写入，该函数实际上从未被触发过

- **待定**：
  - 用户的代理渠道具体支持哪些 claude 模型名（需用户查询渠道后台或尝试其他模型名）
  - 是否期望 extract 失败时有降级行为（如跳过、告警、使用主模型兜底）
  - OS、Node 版本、项目 commit 等环境信息未收集
