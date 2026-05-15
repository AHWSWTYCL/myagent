# Memory

## 项目
- 路径：`/Users/wangshanwu/Desktop/Playgrounds/myagent`
- TypeScript + Anthropic SDK，实现一个 AI agent

## BashTool 黑名单（已实现）
- 文件：`src/tools/bashtool.ts`
- 在 `execute()` 前调用 `checkBlacklist()`，命中则返回 `[BLOCKED]` 提示
- 8 条正则规则：`rm -rf`、删根目录、`mkfs`、`dd` 写裸盘、覆盖 `/etc` 系统文件、fork bomb、shutdown/reboot、curl|sh
- 局限：链式命令可拆分绕过，变量展开无法拦截，生产环境应用沙箱隔离
