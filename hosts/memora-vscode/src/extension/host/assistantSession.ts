/**
 * 助手会话指针（唯一身份真源）
 *
 * 事实形态：助手只有一个，它的会话 id 以**工作区级导航指针**记住（与「上次停留会话」同类），
 * 不是 mode 落盘。指针存在 ⇒ 那条会话按助手装配（`orchestratorSession`）；指针为空 ⇒ 助手窗
 * 是空态，首次发送时建会话并写指针。
 *
 * 为什么单独成模块：`HOSTED-IDENTITY-PERSIST-1` 要求「全仓只有一个助手会话 id 来源」。
 * 读写语义（键名 / 空值归一 / 失效清理）只在这里实现，`SessionModeStore` 与助手窗只做消费，
 * 避开两处各写一份键与判据。
 *
 * 边界：
 *   - 只存 id，不存任何会话内容；
 *   - 失效判定（会话已被删）由**消费方**用 sessionStore 现读校验——本模块不持有会话存储，
 *     也无法判断 id 是否仍存在。
 */
import type { Memento } from 'vscode';

/** 助手会话指针的持久键（工作区级：A 项目的助手不带到 B 项目） */
export const ASSISTANT_SESSION_KEY = 'memora.assistantSessionId';

/**
 * 读助手会话 id
 *
 * @param state 工作区级持久层（`context.workspaceState`）
 * @returns 合法 id；空串 / 非字符串 / 缺省一律 `undefined`（不把脏数据当身份）
 */
export function readAssistantSessionId(state: Memento): string | undefined {
  const raw = state.get<unknown>(ASSISTANT_SESSION_KEY);
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * 写助手会话 id（建会话成功时调用）
 *
 * @param state 工作区级持久层
 * @param sessionId 新的助手会话 id
 */
export function writeAssistantSessionId(state: Memento, sessionId: string): void {
  void state.update(ASSISTANT_SESSION_KEY, sessionId);
}

/**
 * 清助手会话指针（会话被删 / 指针失效时调用）
 *
 * 写成 `undefined` 而不是 `delete`：`Memento` 没有 delete，`undefined` 是 VS Code 的清除语义。
 *
 * @param state 工作区级持久层
 */
export function clearAssistantSessionId(state: Memento): void {
  void state.update(ASSISTANT_SESSION_KEY, undefined);
}
