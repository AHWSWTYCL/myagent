export const toolName = 'git_worktree'
export const toolDescription = '管理 git worktree。create 创建/复用 worktree（自动 symlink node_modules 节省磁盘），exit 退出（检测 uncommitted files + new commits，干净则自动清理，有改动需用户确认），keep 保留 worktree 仅恢复目录，status 查看状态。sub-agent 用 agent_create/agent_remove 获取隔离 worktree（不切换全局 cwd）。'
