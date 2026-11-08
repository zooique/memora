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
 *
 * ## 目录推导与信任判定：单一入口（`projectAssetDirsFor`）
 *
 * 项目级目录的**推导**（`.memora` 下挂 `skills` / `role-packs`）与**信任门判定**
 * 都在本函数的同一个返回点发生，调用方只接收结果、**不得自行拼目录**。
 * 此前 extension.ts 另有一处 `resolveProjectDataDir + join(...)` 的推导，
 * 与信任判定分散两处 ⇒ 任何一处改了目录名/信任口径，另一处会静默走旧值
 * （且没有测试会红）。收成单点后「未信任」与「目录不存在」两种空态同源于此。
 */
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { resolveProjectDataDir } from '../projectDataDir.js';
import { USER_ROLE_PACKS_DIR_NAME, USER_SKILLS_DIR_NAME } from '../../../shared/constants.js';

/**
 * 工作区信任态的**唯一读取点**（宿主侧）
 *
 * 现读 `vscode.workspace.isTrusted`：不缓存、不在 activate 时采样——
 * 信任可在运行期被授予/撤销，快照会与「此刻的真实判定」不同源。
 * 装配期传参（`AssembleOptions.workspaceTrusted`）与信任变化监听都走本函数，
 * 禁止在调用方直接读 API（三处手读 = 三套口径，其中一处漏改不会被任何测试发现）。
 *
 * @returns 工作区是否已受信任
 */
export function readWorkspaceTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

/** 项目级目录对（两者都可缺省：无工作区或未信任时不注入） */
export interface ProjectAssetDirs {
  /** `<workspaceFolder>/.memora/skills` */
  skills?: string;
  /** `<workspaceFolder>/.memora/role-packs` */
  rolePacks?: string;
}

/** 项目级资产的唯一输入上下文（信任判定 + 工作区根） */
export interface ProjectAssetContext {
  /** 工作区是否已受信任（判据真源 = `vscode.workspace.isTrusted`，由调用方现读） */
  isTrusted: boolean;
  /** 工作区根路径（多根工作区只取 `workspaceFolders[0]`；无工作区时缺省） */
  workspaceFolderPath?: string;
}

/**
 * 项目级目录的单点解析（信任门判据 + 目录推导，**唯一实现**）。
 *
 * 未信任 / 无工作区 ⇒ 返回空对象：目录一并消失（UI 的项目级路径展示也随之关闭），
 * 避免「路径给出去、写入却因信任门失败」的双头语义。
 *
 * 信任后目录路径恒定（与工作区根同源，经 `resolveProjectDataDir` 单点，
 * `.memora` 字面量不在本文件出现——受 `dataDirLiteralGuard` 守卫）。
 *
 * @param ctx 信任状态 + 工作区根（调用方现读，不在本模块自存状态副本）
 * @returns 可注入的目录对（未信任 / 无工作区时为空对象）
 */
export function projectAssetDirsFor(ctx: ProjectAssetContext): ProjectAssetDirs {
  if (!ctx.isTrusted || !ctx.workspaceFolderPath) return {};
  const dataDir = resolveProjectDataDir(ctx.workspaceFolderPath);
  return {
    skills: join(dataDir, USER_SKILLS_DIR_NAME),
    rolePacks: join(dataDir, USER_ROLE_PACKS_DIR_NAME),
  };
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

/** 授予信任后的收尾动作依赖（回调注入，本模块不认识面板 / 日志 / 登记表的具体实现） */
export interface GrantedTrustDeps {
  /** 已装配的实例快照（空 = 未装配，下次装配按已信任状态注入） */
  affectedAgents: readonly Agent[];
  /** 已通过信任门的项目级目录 */
  dirs: ProjectAssetDirs;
  /** 标记「所有已装配会话下次取用时重建」，返回标记数（常驻层信任态是装配期快照） */
  markRebuildPending: () => number;
  /** 重推面板技能清单（注入后 UI 与内核同一份） */
  refreshSkillList: () => void;
  /** 写可见记录（Output Channel） */
  report: (line: string) => void;
}

/**
 * 工作区**授予信任后**的完整收尾（补注入 → 标记重建 → 重推面板 → 写记录）
 *
 * **本函数是编排，不是判据；通用判据仍是 `readWorkspaceTrusted()`。**
 * 本文件的主定位仍是读口（信任态 / 项目资产目录）；往这里再加「动作」前先问：
 * 它是不是只是把既有判据的结果串起来？否则应外置到独立模块，别把读口做成写口。
 *
 * 与 `injectProjectAssets` 同文件的理由：顺序契约（注入 → 重扫）已在本模块单点持有，
 * 把收尾编排留在 extension.ts 会让「谁先谁后」再抄一份。
 *
 * 常驻规则层为什么只能标记重建：内核 `ResidentRulesManager` 在装配时按信任态定死启用位，
 * 补注入改不了它 ⇒ 换实例才能从「恒关」变「可用」；忙碌会话由登记表顺延到下一轮取用。
 *
 * @param deps 收尾动作依赖（见 `GrantedTrustDeps`）
 */
export async function applyGrantedWorkspaceTrust(deps: GrantedTrustDeps): Promise<void> {
  // 未装配 ⇒ 不做无意义的全量重扫；下次装配会按已信任状态注入，路径不会漏
  if (deps.affectedAgents.length === 0) return;
  for (const agent of deps.affectedAgents) await injectProjectAssets(agent, deps.dirs);
  const marked = deps.markRebuildPending();
  deps.refreshSkillList();
  deps.report(
    `Memora 工作区已信任：项目级技能/角色包已注入并重扫；` +
      `项目规则将在 ${marked} 个已装配会话的下一轮取用时生效`,
  );
}
