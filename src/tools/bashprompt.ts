export const toolName = 'Bash'
export const toolDescription = `在项目目录执行 shell 命令。自动拦截危险命令（rm -rf、关机、fork bomb 等）。只读命令（ls/cat/git status 等）免权限确认。注意：超时 10 秒，输出上限 50KB。

## GitHub 交互（通过 gh CLI）
所有 GitHub 操作统一使用 gh CLI。不要用 WebFetch 访问 GitHub URL——认证内容 WebFetch 拿不到。

操作流程：
1. 先检查认证状态：gh auth status
2. 如果未认证 → 告诉用户运行 gh auth login，不要继续尝试
3. 认证通过后执行实际操作。

示例操作：
- 创建 Issue：gh issue create --title "标题" --body "内容"
- 创建 PR：  gh pr create --title "标题" --body "$(cat <<'EOF'
  多行 body 内容用 HEREDOC 避免特殊字符问题
  EOF
  )"
- 查看 Issue：gh issue view <number>
- 查看 PR：   gh pr view <number>
- 任意 API： gh api repos/owner/repo/issues

对 GitHub URL 永远优先用 gh CLI，而非 WebFetch。`
