export const toolName = 'Edit'
export const toolDescription = `在文件中执行精确的字符串替换。

## 使用规则
- 先用 read_file 读取文件，然后才能编辑
- old_string 必须精确匹配（包含空白和缩进）
- 如果 old_string 不是唯一匹配，编辑会失败
  - 提供更多上下文使 old_string 唯一
  - 或设置 replace_all=true 替换所有匹配
- replace_all 参数适合重命名变量等全局替换场景
- 编辑后返回 diff 摘要（新增/删除行数）

## 引号处理
- 支持花引号（'' ""）和直引号（' ''）的自动匹配
- 如果文件使用花引号，编辑结果会自动保持花引号风格`
