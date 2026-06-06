export const toolName = 'SendMail'
export const toolDescription = '给另一个 agent（leader 或 teammate）发送邮件。kind=task 派任务，kind=result 汇报结果，kind=status 发进度更新，kind=close 终止 teammate。收件人通过 check_mail 读取。meta 可携带额外字段（如 task_id、ref 邮件 id）。'
