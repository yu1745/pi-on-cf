/**
 * 首页「提问」的一次性转交：catalog 创建会话时存入用户输入，
 * 工作区就绪后取出并作为首条 prompt 自动发送。
 */

let pending = ''

export function setPendingPrompt(prompt: string) {
  pending = prompt
}

export function consumePendingPrompt(): string {
  const value = pending
  pending = ''
  return value
}
