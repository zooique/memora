/**
 * 新建会话的元数据落盘（出生来源 / 标题 / 角色包 / 范围声明）
 *
 * 为什么外置：`chatPanel.createSession` 已贴 `max-lines` 上限，而这段「把可选参数
 * 拼成 `Partial<SessionMeta>`」是完整的小闭环；收进 helpers 后面板只留一行调用，
 * 不为过闸去压缩既有注释。
 *
 * 事实边界：
 *   - `origin` 是**出生事实**：代理开的会话由 `agentCreated` 显式落 `'hosted'`，
 *     其余一律 `'user'`（含助手会话——它是用户在助手窗里首次发送建出来的）；
 *   - `assistant` **不**改变出生来源，只决定装配身份（唯一助手会话）——两者刻意分开记。
 */
import type { SessionMeta } from '@zooique/memora';

/** `createSession` 的可选参数（类型外置以控制面板行数） */
export interface CreateSessionOptions {
  /** 后台建会话（主控代开）：不切显示源、不挑显示源 */
  background?: boolean;
  /** 落 `SessionMeta.displayName`（模型要拿标题跟用户说话） */
  title?: string;
  /** 开活范围声明（与标题同批落元数据，范围门禁的读侧真源） */
  declaredPaths?: readonly string[];
  /**
   * 「这条会话是代理开的」——**只**落出生来源 `'hosted'`，不给调度权
   *
   * 装配身份仍由 `assistant` 决定（代理开的会话传 `false` / 缺省）：两件事分开记，
   * 来源标记只做出生记录，不当权限用。
   */
  agentCreated?: boolean;
  /**
   * 「这条是助手会话」——决定装配身份（写工作区指针），**不改**出生来源
   *
   * 助手唯一：正常只有助手窗首次发送会传 `true`；其余路径缺省即普通会话。
   */
  assistant?: boolean;
  /**
   * 托管开活的语义边界（Mandate）：一段话，「要解决什么问题、不解决什么问题」
   *
   * 与 declaredPaths 的边界（极易混淆）：
   *   - declaredPaths = 技术范围（动哪些仓库相对路径）
   *   - workOrder = 语义边界（解决什么问题、不解决什么问题）
   *   两者不同维度，不可互相替代。
   * 缺省 undefined = 用户自助开的会话（**永远不写**，读侧如实降级）。
   */
  workOrder?: string;
  /**
   * 托管活的工作状态（枚举字符串）
   *
   * 只对代理开的会话有意义（agentCreated = true）。Worker 会话创建后立即进入 'working' 态，
   * 无 queued 中间态。缺省 undefined = 用户自助开的会话（**永远不写**）。
   */
  workStatus?: 'working' | 'blocked' | 'completed' | 'failed';
}

/**
 * 拼出新建会话要写的元数据补丁
 *
 * @param rolePackName 已校验的角色包名（undefined = 不写，走宿主既有解析链）
 * @param opts 建会话可选参数
 * @returns 可直接交给 `SessionStore.updateSessionMeta` 的补丁
 */
export function newSessionMeta(
  rolePackName: string | undefined,
  opts: CreateSessionOptions,
): Partial<SessionMeta> {
  return {
    // 出生来源只由「谁开的」决定：代理开的显式 hosted，其余（含助手会话）都是 user
    origin: opts.agentCreated ? 'hosted' : 'user',
    ...(opts.title ? { displayName: opts.title } : {}),
    ...(rolePackName ? { activeRolePackName: rolePackName } : {}),
    // 开活范围声明与标题同批落元数据，读侧直接读、不反推历史
    ...(opts.declaredPaths?.length ? { declaredPaths: [...opts.declaredPaths] } : {}),
    // 托管开活的语义边界（Mandate）与工作状态：只对代理开的会话有意义，
    // 用户自助开的会话这两个字段永远 undefined，读侧如实降级
    ...(opts.workOrder ? { workOrder: opts.workOrder } : {}),
    ...(opts.workStatus ? { workStatus: opts.workStatus } : {}),
  };
}
