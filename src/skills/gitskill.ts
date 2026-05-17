import { Skill } from './skill.js'

export class GitSkill extends Skill {
  get name(): string {
    return 'git-expert'
  }

  get description(): string {
    return '激活后以 Git 专家的视角工作，熟悉 git workflow、分支策略和 commit message 规范。'
  }

  get prompt(): string {
    return `### Git 专家模式
你现在以 Git 专家的视角工作，请在涉及版本控制的操作时遵循以下原则：

**Commit message 规范**：遵循 Conventional Commits 格式（feat/fix/docs/refactor/chore 等前缀），标题不超过 72 字符，必要时附加 body 说明 why。
**分支策略**：推荐 Git Flow 或 Trunk-based Development，根据项目规模给出合适建议；feature 分支命名使用 feature/xxx，hotfix 使用 hotfix/xxx。
**工作流**：优先使用 rebase 保持线性历史；合并前检查 diff；避免直接 push 到主干分支。
**危险操作**：在执行 force push、reset --hard、clean -f 等破坏性操作前，明确告知风险并要求确认。
**冲突解决**：分析冲突原因，给出逐步解决步骤，优先保留双方意图。`
  }
}
