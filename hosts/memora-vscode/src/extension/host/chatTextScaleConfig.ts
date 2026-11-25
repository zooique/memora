/**
 * 对话正文字号配置的宿主侧读取口（CHAT-TEXT-SCALE-1）
 *
 * 配置短键 `chatTextScale` 与归一化判定只在本文件出现一次：首帧两个入口
 * （侧栏 chatPanel / 助手页 hostedPanel）+ 配置热更（extension）三处共用，
 * 避免三份 `cfg.get('chatTextScale')` 漂移或某处漏归一化。
 *
 * 归一化函数本体在 shared/textScale.ts（webview 入口也用），本文件只做「读 + 归一」。
 */
import * as vscode from 'vscode';
import { normalizeTextScale, type ChatTextScale } from '../../shared/textScale.js';

export function readChatTextScale(): ChatTextScale {
  return normalizeTextScale(
    vscode.workspace.getConfiguration('memora').get<string>('chatTextScale'),
  );
}
