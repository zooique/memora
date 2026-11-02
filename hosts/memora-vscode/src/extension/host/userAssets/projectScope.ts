/**
 * 项目级资产（技能 / 角色包）的信任门与注入执行面。
 *
 * 为什么外置：信任门是**装配期判据 + 运行期补注入**两处共用的一套语义——
 *   ① 装配时按 `isTrusted` 决定传给内核的目录实参；
 *   ② 授予信任后用同一顺序补注入并重扫。
 * 留在 extension.ts 里会变成两处手抄的调用序列（且 extension.ts 不可单测）；
 * 外置后顺序只有一份，且可用桩 Agent 锁定「先注入、后重扫」的次序。
 *
 * 不构成第二套扫描器：扫描全部归内核 `loadExtraDir` / `resync*`，本模块只做编排。
 */
import type { Agent } from '@zooique/memora';

/** 项目级目录对（两者都可缺省：无工作区时不注入） */
export interface ProjectAssetDirs {
  /** `<workspaceFolder>/.memora/skills` */
  skills?: string;
  /** `<workspaceFolder>/.memora/role-packs` */
  rolePacks?: string;
}

/**
 * 信任门判据（纯函数）：未受信任的工作区一律不注入项目级目录。
 *
 * 判据真源 = `vscode.workspace.isTrusted`（调用方传入，不在本模块自存状态副本）；
 * 未信任 ⇒ 返回空对象，装配与补注入两处共用，杜绝「一处判、一处漏判」。
 *
 * @param isTrusted 工作区是否已受信任
 * @param dirs      按工作区推导出的项目级目录
 * @returns 可注入的目录对（未信任时为空对象）
 */
export function projectAssetDirsFor(isTrusted: boolean, dirs: ProjectAssetDirs): ProjectAssetDirs {
  return isTrusted ? dirs : {};
}

/**
 * 把项目级目录注入已装配的 Agent，并重扫全部已登记目录。
 *
 * 顺序契约（与内核加载顺序同源，不可反）：
 *   1. 先 `loadExtraDir(..., 'project')`——档位必须显式传 project，否则内核会把项目覆盖
 *      错记进用户覆盖分账；
 *   2. 再 `resyncUserSkills()` / `resyncUserPacks(..., 'project')`——内核按登记顺序重扫
 *      全部 extra dir（用户在前、项目在后），因此同名覆盖方向仍是 项目 > 用户 > 内置。
 *
 * 目录不存在时内核扫描容错为空（首次使用前 `.memora/skills` 可能尚未创建）。
 *
 * @param agent 已装配的 Agent
 * @param dirs  已通过信任门的项目级目录（未信任时传空对象，本函数自然无动作）
 */
export async function injectProjectAssets(agent: Agent, dirs: ProjectAssetDirs): Promise<void> {
  // 未信任 / 无工作区 ⇒ 无项目级可注入，连重扫都不做（避免无意义的全量重扫）
  if (!dirs.skills && !dirs.rolePacks) return;
  if (dirs.skills) await agent.skills?.loadExtraDir(dirs.skills, 'project');
  if (dirs.rolePacks) await agent.rolePacks?.loadExtraDir(dirs.rolePacks, 'project');
  // 重扫顺序固定：技能与角色包各自重扫全部已登记目录（技能无参、角色包带档位入参）
  await agent.skills?.resyncUserSkills();
  if (dirs.rolePacks) await agent.rolePacks?.resyncUserPacks(dirs.rolePacks, 'project');
}
