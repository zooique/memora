/**
 * 主控建会话（工具 `create_session` 的实现域）
 *
 * 为什么外置：面板已贴 `max-lines` 基线，这段「校验 → 后台建 → 投首轮」是完整闭环，
 * 留在面板只会挤掉既有注释；按 B9-D 的既有拆法，把实现收到 helpers 里，
 * 面板只留一个注入依赖的薄壳（`chatPanel.createHostedSession`）。
 *
 * 事实边界（与面板方法 JSDoc 同口径）：
 *   - 出生来源 = `mode` 走 `'managed'` ⇒ `originForMode` 落 `SessionMeta.origin = 'hosted'`；
 *   - 首轮 `origin: 'hosted'` + `RoundMessage.name = senderName`（装配期注入，不硬编码）；
 *   - 创建复用宿主既有新建路径（`createBackgroundSession`），本模块不碰会话文件；
 *   - 角色包只做**存在性**判定，权限面与用户可选范围完全一致（不额外授权）。
 */
import * as vscode from 'vscode';
import type { CreateSessionResult } from '../../extension/host/workSessionTools.js';

// 本模块错误文案走 l10n（与面板同一套键面）
const { l10n } = vscode;

/** 建会话依赖（全部由面板注入，本模块不持有任何实例） */
export interface HostedSessionCreateDeps {
  /** 调用方是否托管（纵深防守：不只靠工具面缺席） */
  isManaged: (sessionId: string) => boolean;
  /** 角色包编目读口（undefined = 编目不可用） */
  readRolePackCatalog?: () => Promise<ReadonlySet<string> | null>;
  /**
   * 按既有新建路径**后台**建会话
   *
   * 后台 = 不切显示源、不写用户级「上次模式」；只落 meta / 装配 / 刷会话清单。
   */
  createBackgroundSession: (
    sessionId: string,
    rolePackName: string | undefined,
    title: string,
  ) => Promise<boolean>;
  /** 走既有 runFlow 通路投递首轮（fire-and-forget，不等待模型跑完） */
  startFlow: (sessionId: string, text: string, senderName: string) => Promise<void>;
  /** 新会话 id 生成（形态单点，不在此拼接日期） */
  nextSessionId: () => string;
}

/**
 * 开一个新会话并把首轮交给它
 *
 * @param deps 面板注入的窄依赖
 * @param callingSessionId 调用方（非托管一律 E_DENIED）
 * @param rolePackName 角色包名（undefined = 宿主既有解析链）
 * @param title 会话标题（落 displayName，并原样返回给模型跟用户说话）
 * @param text 首轮输入
 * @param senderName 首轮发送者名（装配期注入）
 * @returns 成功 = sid + title；失败一律 `{ ok:false }`，不 throw
 */
export async function createHostedSessionWith(
  deps: HostedSessionCreateDeps,
  callingSessionId: string,
  rolePackName: string | undefined,
  title: string,
  text: string,
  senderName: string,
): Promise<CreateSessionResult> {
  if (!deps.isManaged(callingSessionId)) {
    return {
      ok: false,
      code: 'E_DENIED',
      message: l10n.t('Memora: only managed sessions can create sessions.'),
    };
  }
  if (rolePackName !== undefined) {
    // 编目读口缺失 / 读失败 = 「不可用」，与「包名不存在」同码；**绝不**折算成 E_NOT_FOUND
    const catalog = deps.readRolePackCatalog ? await deps.readRolePackCatalog() : null;
    if (!catalog || !catalog.has(rolePackName)) {
      return {
        ok: false,
        code: 'E_ROLE_PACK',
        message: l10n.t('Memora: role pack not found or unavailable: {0}', rolePackName),
      };
    }
  }
  const sessionId = deps.nextSessionId();
  const created = await deps.createBackgroundSession(sessionId, rolePackName, title);
  if (!created) {
    return {
      ok: false,
      code: 'E_HOST',
      message: l10n.t('Memora: could not create the session.'),
    };
  }
  // 首轮投递：实例已在建会话链路内装配并记入投影表，这里只取不建
  await deps.startFlow(sessionId, text, senderName);
  return { ok: true, sid: sessionId, title };
}
