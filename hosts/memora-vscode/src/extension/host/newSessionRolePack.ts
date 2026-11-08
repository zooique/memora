/**
 * 新建会话的角色包决策（**唯一决策点**）
 *
 * 取值链（自左向右，先命中者胜）：
 *   ① 草稿显式选择（用户在建会话前选过包）→ 直接采用，不再校验（选择时已校验存在性）；
 *   ② 用户级默认 `memora.defaultRolePack`（→ 由 rolePackDefault.ts 单点读取）；
 *   ③ 都没有 ⇒ 不写 meta，交给内核装配链 §4.1 的兜底包（`BUILTIN_FALLBACK_PACK`）。
 *
 * 校验真相源 = **角色包目录编目**（`RolePackCatalogReader`，由宿主用内核 `RolePackManager`
 * 按装配同一份目录清单扫出，见 rolePackCatalog.ts）。冷启动没有任何已装配实例时目录照样可读，
 * 因此不存在「校验不了就乐观放行」的分支——失效名永远不会被写进 `SessionMeta`。
 *
 * 历史事实（2026-11-08 之前的实现，**已落盘档案不回填**）：旧版以「已装配实例的
 * rolePackManager」为探针，实例集合为空时返回 true（乐观放行）⇒ 冷启动第一个会话可能把
 * 已失效的默认名写进 meta，随后落进「老会话」判据弹「原角色包不可用」，且同名包重装后
 * 该会话会自动复活。这些档案**不做迁移**：无法区分「误写」与「用户真选后包被删」，
 * 且危害仅限一次误导提示与重装后的意外激活，改写用户档案的代价高于收益。
 *
 * 红线：本模块**只做决策**，不写 `SessionMeta`——落盘仍在面板建会话处一次性完成（快照语义），
 * 也不得在装配期调用（否则老会话会被后改的全局默认追溯改写）。
 */
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { resolveNewSessionRolePackName } from './rolePackDefault.js';
import {
  defaultRolePackFallbackNotice,
  defaultRolePackUnverifiedNotice,
} from './sessionRolePack.js';

/**
 * 角色包目录编目读面（实现见 rolePackCatalog.ts；测试可直接注入字面集合）
 *
 * @returns 目录内全部角色包名；`null` = 目录读不到（校验不可用，与「包不存在」区分）
 */
export type RolePackCatalogReader = () => Promise<ReadonlySet<string> | null>;

/** 新建会话的角色决策结果（三种出口互斥，提示文案不许合并） */
export interface NewSessionRoleDecision {
  /** 要写进 `SessionMeta.activeRolePackName` 的包名（undefined = 不写） */
  rolePackName?: string;
  /** 默认名在目录中不存在 ⇒ 不写 meta；装配后提示「默认角色包不可用」 */
  unavailableName?: string;
  /** 目录读不到、无法校验 ⇒ 不写 meta；装配后提示「无法校验」（不假装成功） */
  unverifiableName?: string;
}

/**
 * 解析新建会话应使用的角色包
 *
 * @param explicitName 草稿期显式选择（undefined = 未选；空串按未选处理）
 * @param readCatalog 角色包目录编目读面（未注入视同「读不到」，**不得乐观放行**）
 * @returns 决策结果（写不写 meta、要不要发提示）
 */
export async function decideNewSessionRolePack(
  explicitName: string | undefined,
  readCatalog: RolePackCatalogReader | undefined,
): Promise<NewSessionRoleDecision> {
  // ① 草稿显式选择：`undefined` 才代表「没选过」；空串与未选同义（不写 meta）
  if (explicitName !== undefined) {
    return explicitName ? { rolePackName: explicitName } : {};
  }
  // ② 用户级默认（单点读取；空串 = 未设置 ⇒ 走现状：内核兜底包）
  const requested = resolveNewSessionRolePackName();
  if (!requested) return {};
  // ③ 校验不可用 ≠ 包不存在：前者保持「不写 meta」，但走独立文案（否则用户会去改包名）
  if (!readCatalog) return { unverifiableName: requested };
  const catalog = await readCatalog();
  if (!catalog) return { unverifiableName: requested };
  return catalog.has(requested) ? { rolePackName: requested } : { unavailableName: requested };
}

/**
 * 把决策结果映射成装配后要投递的提示（三出口文案各自独立）
 *
 * 必须在 `bindAgent` 之后调用：两种失败都要带上装配实际落到的角色名。
 *
 * @param decision 本轮的决策结果
 * @param activeName 装配后内核实际激活名（null = 连兜底包都缺失）
 * @returns 需要下发的 notice；校验通过 / 未设置默认时返回 null
 */
export function newSessionRolePackNotice(
  decision: NewSessionRoleDecision,
  activeName: string | null | undefined,
): ExtensionToWebviewMessage | null {
  if (decision.unavailableName) {
    return defaultRolePackFallbackNotice(decision.unavailableName, activeName);
  }
  if (decision.unverifiableName) {
    return defaultRolePackUnverifiedNotice(decision.unverifiableName, activeName);
  }
  return null;
}
