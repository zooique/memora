/**
 * 新建会话的元数据落盘（出生来源 / 标题 / 角色包 / 范围声明）
 *
 * 为什么外置：`chatPanel.createSession` 已贴 `max-lines` 上限，而这段「把可选参数
 * 拼成 `Partial<SessionMeta>`」是完整的小闭环；收进 helpers 后面板只留一行调用，
 * 不为过闸去压缩既有注释。
 *
 * 事实边界：
 *   - `origin` 是**出生事实**：代理开的会话由 `agentCreated` 显式落 `'hosted'`，
 *     其余按 `mode` 经 `originForMode` 映射（唯一映射点）；
 *   - `agentCreated` **不**改变装配身份：代理开的会话 mode 传 `'self'`，拿不到调度权；
 *   - `declaredPaths` 与标题同批落，读侧直接读元数据、不反推历史。
 */
import type { SessionMeta } from '@zooique/memora';
import { originForMode, type SessionMode } from '../../extension/host/sessionModeStore.js';

/** `createSession` 的可选参数（类型外置以控制面板行数） */
export interface CreateSessionOptions {
  /** 后台建会话（主控代开）：不切显示源、不写「上次模式」、不换绑实例 */
  background?: boolean;
  /** 落 `SessionMeta.displayName`（模型要拿标题跟用户说话） */
  title?: string;
  /** 开活范围声明（与标题同批落元数据，范围门禁的读侧真源） */
  declaredPaths?: readonly string[];
  /**
   * 「这条会话是代理开的」——**只**落出生来源 `'hosted'`，不给调度权
   *
   * 装配身份仍由 `mode` 决定（代理开的会话传 `'self'`）：两件事分开记，
   * 来源标记只做出生记录，不当权限用。
   */
  agentCreated?: boolean;
}

/**
 * 拼出新建会话要写的元数据补丁
 *
 * @param mode 装配身份（`managed` = 用户亲自选择的托管会话；`self` = 其余）
 * @param rolePackName 已校验的角色包名（undefined = 不写，走宿主既有解析链）
 * @param opts 建会话可选参数
 * @returns 可直接交给 `SessionStore.updateSessionMeta` 的补丁
 */
export function newSessionMeta(
  mode: SessionMode,
  rolePackName: string | undefined,
  opts: CreateSessionOptions,
): Partial<SessionMeta> {
  return {
    // 来源标记与调度权分开：代理开的会话显式 hosted；其余按 mode 映射
    origin: opts.agentCreated ? 'hosted' : originForMode(mode),
    ...(opts.title ? { displayName: opts.title } : {}),
    ...(rolePackName ? { activeRolePackName: rolePackName } : {}),
    // 开活范围声明与标题同批落元数据，读侧直接读、不反推历史
    ...(opts.declaredPaths?.length ? { declaredPaths: [...opts.declaredPaths] } : {}),
  };
}
