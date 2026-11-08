/**
 * 新建会话的角色包决策（**唯一决策点** · 纯函数）
 *
 * 取值链（自左向右，先命中者胜）：
 *   ① 草稿显式选择（用户在建会话前选过包）→ 直接采用，不再校验（选择时已校验存在性）；
 *   ② 用户级默认 `memora.defaultRolePack`（→ 由 rolePackDefault.ts 单点读取）；
 *   ③ 都没有 ⇒ 不写 meta，交给内核装配链 §4.1 的兜底包（`BUILTIN_FALLBACK_PACK`）。
 *
 * 为什么必须独立成模块：
 *   - chatPanel 贴 max-lines 只降不升基线，「决策 + 失效判定」不该再往里塞；
 *   - 「默认包是否可用」的判据只能有一份：写 meta / 发提示 / 不写 meta 三条分支同源，
 *     分家后会出现「写了失效名或提示说错」的静默漂移（没有任何测试会红）。
 *
 * 红线：本模块**只做决策**，不写 `SessionMeta`——落盘仍在面板建会话处一次性完成（快照语义），
 * 也不得在装配期调用（否则老会话会被后改的全局默认追溯改写）。
 */
import { resolveNewSessionRolePackName } from './rolePackDefault.js';

/** 角色包目录的最小读面（只用到存在性查询） */
interface RolePackDirectory {
  get?: (packName: string) => unknown;
}

/** 角色包存在性探针的最小读面（不引入 Agent 全类型；只用到 `rolePackManager.get`） */
export interface RolePackProbe {
  rolePackManager?: RolePackDirectory | null;
}

/** 新建会话的角色决策结果 */
export interface NewSessionRoleDecision {
  /** 要写进 `SessionMeta.activeRolePackName` 的包名（undefined = 不写，装配落内核兜底链） */
  rolePackName?: string;
  /** 用户级默认名解析不到时的包名（undefined = 默认可用 / 未设置 ⇒ 无需提示） */
  unavailableName?: string;
}

/**
 * 解析新建会话应使用的角色包
 *
 * @param explicitName 草稿期显式选择（undefined = 未选；空串按未选处理）
 * @param probes 已装配实例（存在性校验的只读真源；空集 = 冷启动，乐观放行）
 * @returns 决策结果（写不写 meta、要不要发「默认角色包不可用」提示）
 */
export function decideNewSessionRolePack(
  explicitName: string | undefined,
  probes: Iterable<RolePackProbe>,
): NewSessionRoleDecision {
  // ① 草稿显式选择：`undefined` 才代表「没选过」；空串与未选同义（不写 meta）
  if (explicitName !== undefined) {
    return explicitName ? { rolePackName: explicitName } : {};
  }
  // ② 用户级默认（单点读取；空串 = 未设置 ⇒ 走现状：内核兜底包）
  const requested = resolveNewSessionRolePackName();
  if (!requested) return {};
  // ③ 默认可失效（用户可能删包/换机器）：解析不到 ⇒ 不写 meta，由调用方装配后如实提示
  return isRolePackInstalled(requested, probes)
    ? { rolePackName: requested }
    : { unavailableName: requested };
}

/**
 * 角色包是否已安装（只读校验，不装配）
 *
 * 真源 = 任一已装配实例的 `rolePackManager`（与内核装配读同一份目录，宿主不另写扫描器）。
 * 尚无任何实例（冷启动第一个会话）⇒ 无法校验，返回 true 不阻断建会话，
 * 失效最终由装配回落 + notice 链路兜底（此时无法保证「不写 meta」）。
 *
 * @param name 待校验的角色包名
 * @param probes 已装配实例（按「当前显示源优先」的顺序传入）
 * @returns 是否存在；无任何实例可校验时返回 true（乐观放行）
 */
function isRolePackInstalled(name: string, probes: Iterable<RolePackProbe>): boolean {
  for (const probe of probes) {
    const rpm = probe.rolePackManager;
    if (typeof rpm?.get === 'function') return !!rpm.get(name);
  }
  return true;
}
