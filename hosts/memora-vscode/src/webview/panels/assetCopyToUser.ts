/**
 * 设置页「添加到用户级」编排层（项目级资产 → 用户级目录）
 *
 * ## 为什么在 panels 下、而不是继续塞进 settingsPanel
 * `settingsPanel.ts` 逼近 eslint max-lines 基线（只降不升），而本动作同时要处理两种资产
 * 的来源断言、确认弹窗、回执文案与双列表刷新——放进面板只会把面板推过闸。外置后
 * 面板只留一行分发，本文件可独立阅读。
 *
 * ## 不变量（改之前先读）
 *   - **执行面只有一处**：落盘 = `zipImport.ts` 的 `copyAssetToRoot`（暂存 → 备份 →
 *     rename → 失败回滚 → 回滚失败转 `.recovery-`），本文件只做编排，**不碰 fs**；
 *   - **拷贝，不是同步**：复制后项目级与用户级是两份独立资产，任一侧后续变更都不传播；
 *   - **复制单元 = 内核给出的资产包根**（`SkillEntry.packageRoot` / `RolePack.packageRoot`）：
 *     单文件技能 = 文件、目录式技能 = 技能目录、角色包 = 包目录。宿主**零推导**——
 *     不 `dirname(filePath)`，也不按「同目录有没有 SKILL.md」猜（猜法必与内核扫描器漂移）；
 *   - **资产类型（kind）只决定校验规则与文案**，不决定复制单元；
 *   - **只受理项目级来源**：技能按聚合结果的 `layer === 'project'`，角色包按
 *     `isPathWithin(项目角色包根, filePath)`——防止把用户级资产「复制到它自己」；
 *   - 同名 = 显式覆盖（先备份、可回滚），取消时回执写明「未做任何写入」，**不静默跳过**。
 *
 * ## 射程边界（对外措辞）
 * 本轮只收回 LLM 的**正常工具路径**写权限；`run_code` / `run_skill_script` 等任意代码
 * 执行面仍不设防。回执与 UI 只可写「正常工具路径不再写用户目录」，不得写
 * 「模型无法写用户目录」。
 */
import type { Agent } from '@zooique/memora';
import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { isPathWithin } from '../../extension/host/userAssets/path.js';
import {
  copyAssetToRoot,
  type OverwritePrompt,
} from '../../extension/host/userAssets/zipImport.js';
import { confirmModal } from '../../extension/host/ui/confirmModal.js';
import { listVisibleSkills } from '../../extension/host/skillAggregation.js';
import { refreshUserRolePacksFlow, refreshUserSkillsFlow } from './userAssetRefresh.js';

/** 面板提供给复制编排层的依赖（全部由面板自持，本层不重新解析路径） */
export interface AssetCopyDeps {
  /** 惰性取 Agent（面板可能在装配完成前打开；未装配时返回 undefined） */
  ensureAgent: () => Promise<Agent | undefined>;
  /** 回执投递（notice） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 内核技能配置目录（技能聚合入参） */
  configDir?: string;
  /** 用户级技能目录（复制目标） */
  userSkillsDir?: string;
  /** 项目级技能目录（聚合入参） */
  projectSkillsDir?: string;
  /** 用户级角色包目录（复制目标） */
  userRolePacksDir?: string;
  /** 项目级角色包目录（来源归属判据） */
  projectRolePacksDir?: string;
  /** 技能页列表重载 */
  loadSkills: () => Promise<void>;
  /** 角色页列表重载 */
  loadRoles: () => Promise<void>;
  /** 对话区技能下拉刷新 */
  refreshChatSkills: () => void;
}

/**
 * 失败回执（统一错误通道，避免每个分支各写一遍 notice 字面量）
 *
 * @param deps 面板依赖
 * @param message 面向用户的原因（执行面给的具体原因必须原样带出）
 */
function postCopyError(deps: AssetCopyDeps, message: string): void {
  deps.post({ type: 'notice', level: 'error', message });
}

/**
 * 复制成功回执文案（技能 / 角色包共用一份，避免两份措辞从落笔起漂移）
 *
 * 必须同时写明四件事，缺一即误导：
 *   1. **去重优先级**：同一项目内项目级优先（`project:1 > user:2`），用户级同名副本默认不显示——
 *      不写这句，用户点完看到「界面没变化」会以为复制失败；
 *   2. 绝对落点（用户能自己去核实）；
 *   3. 文件数（只数叶子，与压缩包导入口径一致）；
 *   4. **副本，不是同步**（之后两侧互不影响，免得用户以为改了项目级用户级会跟着变）。
 *
 * @param label 面向用户的资产类型名（「技能」/「角色包」）
 * @param name 资产名
 * @param result 执行面成功回执（绝对落点 + 文件数）
 */
function copySuccessMessage(
  label: string,
  name: string,
  result: { targetPath: string; fileCount: number },
): string {
  return vscode.l10n.t(
    'Copied {0} "{1}" to the user level: {2} ({3} files). The user-level copy is ready; project-level wins inside the same project, so the user-level copy only applies in other projects. This is a copy, not a sync — the project-level and user-level copies stay independent.',
    label,
    name,
    result.targetPath,
    result.fileCount,
  );
}

/**
 * 缺包根时的拒绝文案（技能 / 角色包共用）：`packageRoot` 是内核可选字段，外部经 `register()`
 * 注入的条目可能没有——**不猜**（不按 `filePath` 反推包根），缺根即明确拒绝并给出原因。
 *
 * @param assetLabel 面向用户的资产类型名（「技能」/「角色包」）
 * @param name 资产名
 */
function missingPackageRootMessage(assetLabel: string, name: string): string {
  return vscode.l10n.t(
    'The kernel did not provide a package root (packageRoot) for {0} "{1}", so it cannot be copied to the user level safely',
    assetLabel,
    name,
  );
}

/**
 * 同名覆盖确认回调（复制到用户级共用）：两个入口只差资产名词，
 * 附属文案与按钮集（只传「覆盖」）不得分叉。
 *
 * @param assetLabel 面向用户的资产类型名（「技能」/「角色包」）
 */
function confirmOverwriteCopy(assetLabel: string): (prompt: OverwritePrompt) => Promise<boolean> {
  return (prompt) =>
    confirmModal({
      message: vscode.l10n.t(
        'A user-level {0} with the same name already exists: {1}',
        assetLabel,
        prompt.targetPath,
      ),
      detail: vscode.l10n.t(
        'Continuing backs up the existing content before overwriting, and rolls back automatically on failure. Copy now?',
      ),
      confirmLabel: vscode.l10n.t('Overwrite'),
    });
}

/**
 * 把项目级技能复制到用户级（设置页项目技能卡片「添加到用户级」的落点）
 *
 * @param deps 面板依赖
 * @param skillName 技能名（UI 回传的唯一 id）
 */
export async function copyProjectSkillToUser(
  deps: AssetCopyDeps,
  skillName: string,
): Promise<void> {
  const agent = await deps.ensureAgent();
  if (!agent?.skills || !deps.configDir || !deps.userSkillsDir) {
    postCopyError(
      deps,
      vscode.l10n.t(
        'The skill system or the user directory is not ready; cannot copy to the user level',
      ),
    );
    return;
  }
  // 只认项目级来源：同名技能可能同时存在于用户级（项目优先），用聚合 layer 再断言一次
  const skill = listVisibleSkills({
    agent,
    configDir: deps.configDir,
    userSkillsDir: deps.userSkillsDir,
    projectSkillsDir: deps.projectSkillsDir,
  }).find((s) => s.name === skillName && s.layer === 'project');
  if (!skill?.filePath) {
    postCopyError(
      deps,
      vscode.l10n.t(
        'Project-level skill "{0}" not found; cannot copy to the user level',
        skillName,
      ),
    );
    return;
  }

  // 复制单元 = 内核给出的包根（单文件技能 = 文件；目录式技能 = 技能目录），宿主不拿 filePath 反推
  if (!skill.packageRoot) {
    postCopyError(deps, missingPackageRootMessage(vscode.l10n.t('skill'), skillName));
    return;
  }
  const result = await copyAssetToRoot(skill.packageRoot, deps.userSkillsDir, {
    // 类型由本层显式声明，只影响校验分支与文案（不决定复制单元）
    kind: 'skill',
    // 同名覆盖确认走共用回调（只传「覆盖」；取消是 VS Code modal 自带的 Cancel ⇒ false）
    confirmOverwrite: confirmOverwriteCopy(vscode.l10n.t('skill')),
  });
  if (!result.ok) {
    postCopyError(deps, vscode.l10n.t('Failed to copy to the user level: {0}', result.reason));
    return;
  }
  deps.post({
    type: 'notice',
    level: 'info',
    message: copySuccessMessage(vscode.l10n.t('skill'), skillName, result),
  });
  await refreshUserSkillsFlow({
    agent,
    post: deps.post,
    reloadList: deps.loadSkills,
    refreshChatSkills: deps.refreshChatSkills,
  });
}

/**
 * 把项目级角色包复制到用户级（设置页项目角色包卡片「添加到用户级」的落点）
 *
 * @param deps 面板依赖
 * @param name 角色包标识（manifest `name`）
 */
export async function copyProjectRolePackToUser(deps: AssetCopyDeps, name: string): Promise<void> {
  const agent = await deps.ensureAgent();
  const rpm = agent?.rolePackManager;
  if (!rpm || !deps.userRolePacksDir) {
    postCopyError(
      deps,
      vscode.l10n.t(
        'The role-pack system or the user directory is not ready; cannot copy to the user level',
      ),
    );
    return;
  }
  // 来源归属以 filePath 为唯一判据，不猜来源；同名时内核池项目级优先，但仍逐路径核对
  const pack = rpm.get(name);
  if (!pack || !isPathWithin(deps.projectRolePacksDir, pack.filePath)) {
    postCopyError(
      deps,
      vscode.l10n.t('"{0}" is not a project-level role pack; cannot copy to the user level', name),
    );
    return;
  }
  // 复制单元 = 包根（包目录），由内核装配时给出；缺字段即拒绝，宿主不拿 manifest 路径反推
  if (!pack.packageRoot) {
    postCopyError(deps, missingPackageRootMessage(vscode.l10n.t('role pack'), name));
    return;
  }

  const result = await copyAssetToRoot(pack.packageRoot, deps.userRolePacksDir, {
    kind: 'rolePack',
    // 同名覆盖确认走共用回调（只传「覆盖」；取消是 VS Code modal 自带的 Cancel ⇒ false）
    confirmOverwrite: confirmOverwriteCopy(vscode.l10n.t('role pack')),
  });
  if (!result.ok) {
    postCopyError(deps, vscode.l10n.t('Failed to copy to the user level: {0}', result.reason));
    return;
  }
  deps.post({
    type: 'notice',
    level: 'info',
    message: copySuccessMessage(vscode.l10n.t('role pack'), name, result),
  });
  await refreshUserRolePacksFlow({
    agent,
    userRolePacksDir: deps.userRolePacksDir,
    post: deps.post,
    reloadList: deps.loadRoles,
  });
}
