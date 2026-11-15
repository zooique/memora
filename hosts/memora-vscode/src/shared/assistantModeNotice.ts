/**
 * 助手形态下「用户侧新建会话」的统一提示（唯一措辞来源）
 *
 * 为什么需要：助手形态的语义是「你说需求，助手安排会话」；用户自己再开一条会话会造出
 * 第二条托管会话，工作台因此要问「看哪条座位」（真机表现为「助手不是只有一个吗」）。
 * 故该形态下用户侧的新建入口（标题条「＋」/ 命令面板）一律不建会话，统一回这一句：
 * 告诉用户「跟助手说」与「先切回自助」，而不是让按钮点了没反应。
 *
 * 消费方：`chatPanel` 的 `new_session` 消息分支（宿主执行面守护）、
 * `commands/newSession` 的命令面板入口。两处必须共用本函数，禁止各写一份字面量。
 */
import * as vscode from 'vscode';

/**
 * 取「助手形态不新建会话」的提示文案
 *
 * @returns 已本地化的提示（英文源键在资源包内翻译）
 */
export function assistantModeCreatesSessionsNotice(): string {
  return vscode.l10n.t(
    'In assistant mode, tell the assistant what to do and it will arrange the sessions. To create a session yourself, switch back to self mode first.',
  );
}
