export const toolName = 'CheckMail'
export const toolDescription = [
  '查看自己的邮箱。mode=pop 消费最早一封匹配的邮件并标记已读（通常用这个），mode=peek 列出但不消费。可选 kind/from 过滤。无匹配时返回 "(empty)"。主 agent 用这个工具来查看 teammate 发来的状态和结果。',
  '',
  '⚠️ 当你收到 [New Mail] 通知（来自 drainMailbox 自动归集）时，必须立即用 check_mail mode=pop 逐封取出处理，不能先做其他事：',
  '  1. pop 取出一封 → 按内容回复/执行 → 再 pop 下一封',
  '  2. 重复直到 "(empty)"',
  '  3. 全部处理完再继续其他工作',
  '这样未处理的邮件不会因 drainMailbox 重复推送。',
].join('\n')
