/**
 * 会话级角色包：读回 + 解析失败告知（**判据单点**）
 *
 * 两个消费面共用同一判据「会话文件里的名字 ↔ 内核实际激活名」：
 *   ① 装配注入：读 `SessionMeta.activeRolePackName` → `AgentOptions.activeRolePack`；
 *   ② 用户告知：装配后若名字解析不到（内核已回落兜底链）→ 产出一条 error 级 notice。
 *
 * 为什么不许各写一份：判据一旦分家，「算不算解析失败」「文案说什么」就会各自漂移，
 * 而这类漂移**没有任何测试会红**（用户看到的是一条看似正常的提示，或干脆没有提示）。
 *
 * 语义（与内核 `SessionMeta.activeRolePackName` 的 JSDoc 同源）：
 *   - 存的是**名字快照**，不是「该包仍可用」的保证；
 *   - 解析是**装配期一次性**的：同名包重装后，已装配的 Agent 不会自动热切回；
 *     需重新装配（重开面板 / 重启宿主）或手动切回——这一条同时写进台账与 CHANGELOG。
 */
import type { SessionMeta } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 会话元数据读取的最小面（避免把整个 WorkspaceSessionStore 类型拖进纯判据） */
export interface SessionMetaReader {
  getSessionMeta(sessionId: string): SessionMeta | undefined;
}

/**
 * 读回某会话记录的角色包名
 *
 * @param store 会话存储（宿主单例）
 * @param sessionId 会话标识（空串 / 会话不存在 → undefined）
 * @returns 名字快照；字段缺失或为空串一律 `undefined`（= 该会话从未主动选过角色）
 */
export function readSessionRolePackName(
  store: SessionMetaReader,
  sessionId: string,
): string | undefined {
  if (!sessionId) return undefined;
  const name = store.getSessionMeta(sessionId)?.activeRolePackName;
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 构造「原角色包不可用」的可见提示（纯函数；无失败返回 null）
 *
 * @param requested 会话记录里写的包名（undefined = 该会话没选过角色 ⇒ 不是失败，不提示）
 * @param activeName 装配后内核实际激活的包名（null = 连兜底包都缺失）
 * @returns error 级 notice；名字一致 / 无 requested 时返回 null
 */
export function rolePackFallbackNotice(
  requested: string | undefined,
  activeName: string | null | undefined,
): ExtensionToWebviewMessage | null {
  // 没选过角色 ⇒ 兜底包是「默认值」而非「回落」，不算失败（老会话零打扰）
  if (!requested) return null;
  // 按名解析成功 ⇒ 正常路径，零提示
  if (requested === activeName) return null;
  const message = activeName
    ? `原角色包「${requested}」已不可用，当前使用默认角色「${activeName}」。`
    : `原角色包「${requested}」已不可用，且兜底角色包缺失，当前无可用角色。`;
  return { type: 'notice', level: 'error', message };
}

/**
 * 构造「默认角色包不可用」的可见提示（纯函数；无失败返回 null）
 *
 * 与 {@link rolePackFallbackNotice} 分开的原因：默认包不是用户在**该会话**里选过的角色，
 * 文案不能说「原角色包」；且该路径**不写 meta**，不能让既有回落提示承接。
 *
 * @param requested 用户级默认设置里的包名（空串 = 未设置 ⇒ 不提示）
 * @param activeName 装配后内核实际激活的包名（null = 连兜底包都缺失）
 * @returns error 级 notice；能解析成功时返回 null
 */
export function defaultRolePackFallbackNotice(
  requested: string,
  activeName: string | null | undefined,
): ExtensionToWebviewMessage | null {
  if (!requested || requested === activeName) return null;
  const message = activeName
    ? `默认角色包「${requested}」不可用，当前使用兜底角色「${activeName}」。`
    : `默认角色包「${requested}」不可用，且兜底角色包缺失，当前无可用角色。`;
  return { type: 'notice', level: 'error', message };
}

/**
 * 「无法校验」的中性措辞（**不指定原因**，建会话与设置页共用同一句）
 *
 * 编目侧把 `RolePackManager.load()` 的任何异常都降级为「读不到」（保守方向：宁可报无法校验，
 * 也不误判成包不存在去催用户改包名），而异常既可能来自目录 IO，也可能来自某个包 manifest
 * 损坏。**说错原因比不说原因更糟**——用户会照着错误归因去修一个不存在的目录问题。
 * 精确归因需区分内核内部错误类型（内核面改动），故本期只保留中性表述。
 */
export const UNVERIFIED_ROLE_PACK_TEXT = '无法校验角色包列表';

/**
 * 构造「默认角色包无法校验」的可见提示（纯函数；仅在编目读不到时使用）
 *
 * 与「默认角色包不可用」必须分开：这两件事的**用户可行动作不同**——
 *   - 不可用 = 包确实不在目录里 ⇒ 用户应重选一个存在的默认包；
 *   - 无法校验 = 列表读不到、存在性无从判断 ⇒ 重选包也不会生效，先别改包名。
 * 合并成一句会让第二种情况被当成第一种，用户照着改包名永远修不好。
 *
 * @param requested 用户级默认设置里的包名
 * @param activeName 装配后内核实际激活的包名（null = 连兜底包都缺失）
 * @returns error 级 notice
 */
export function defaultRolePackUnverifiedNotice(
  requested: string,
  activeName: string | null | undefined,
): ExtensionToWebviewMessage | null {
  if (!requested) return null;
  const message = activeName
    ? `默认角色包「${requested}」${UNVERIFIED_ROLE_PACK_TEXT}，已使用兜底角色「${activeName}」。`
    : `默认角色包「${requested}」${UNVERIFIED_ROLE_PACK_TEXT}，且兜底角色包缺失，当前无可用角色。`;
  return { type: 'notice', level: 'error', message };
}

/**
 * 一次性取「某会话是否发生了角色包回落」的提示（供面板 bindAgent 直接 post）
 *
 * @param store 会话存储
 * @param sessionId 当前显示会话
 * @param activeName 装配后内核实际激活名
 * @returns 需要下发的 notice；无失败返回 null
 */
export function sessionRolePackFallbackNotice(
  store: SessionMetaReader,
  sessionId: string,
  activeName: string | null | undefined,
): ExtensionToWebviewMessage | null {
  return rolePackFallbackNotice(readSessionRolePackName(store, sessionId), activeName);
}
