/**
 * 文档上下文前缀处理 — 剥离宿主注入的「当前打磨文档内容」前缀
 *
 * 说明：宿主在 handleSend 将当前打磨文档作为「当前任务上下文」注入 chat 输入，
 * 内核 appendUser 持久化的 user 消息因此带 `[当前打磨文档内容]...` 前缀。回放历史
 * 时应剥离前缀，只显示用户请求原文。纯字符串操作、无依赖，可独立测试
 * （阶段 A 对抗评估 P2-1：从 chatPanel.ts 抽出为可测模块，固化 P1-6 修复）。
 */

/**
 * 剥离 user 消息中的「当前打磨文档内容」前缀（仅用于 UI 回显）
 *
 * 注入结构固定：`[当前打磨文档内容]\n{doc}\n[/当前打磨文档内容]\n\n用户请求：{input}`。
 * 以「关闭标签」为锚点，在其后定位首个分隔 marker：注入的 marker 总紧跟在关闭
 * 标签之后，而用户 input 中若含「用户请求：」字样必然出现在其后，因此不会误剥
 * 用户内容（对抗评估 P1-6，替代原先 lastIndexOf 会误伤用户输入含该字样的缺陷）。
 * 无前缀的普通 user 消息（resume 补写、无文档场景）原样返回。
 *
 * @param content 内核持久化的 user 消息原文
 * @returns 剥离前缀后的用户请求文本
 */
export function stripDocContextPrefix(content: string): string {
  // 仅当消息确实以「当前打磨文档内容」标记开头才剥离（文档上下文注入的前缀），
  // 普通对话（resume 补写、无文档场景）内容不含该标记，原样返回。
  if (!content.startsWith('[当前打磨文档内容]')) return content;
  const closeTag = '[/当前打磨文档内容]';
  const closeIdx = content.indexOf(closeTag);
  if (closeIdx < 0) return content;
  const marker = '\n\n用户请求：';
  const idx = content.indexOf(marker, closeIdx);
  if (idx < 0) return content;
  return content.slice(idx + marker.length);
}
