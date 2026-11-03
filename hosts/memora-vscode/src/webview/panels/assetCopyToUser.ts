/**
 * 设置页「添加到用户级」编排层（项目级资产 → 用户级目录）
 *
 * ## 为什么在 panels 下、而不是继续塞进 settingsPanel
 * `settingsPanel.ts` 贴 eslint max-lines 上限（只降不升），而本动作同时要处理两种资产
 * 的来源断言、确认弹窗、回执文案与双列表刷新——放进面板只会把面板推过闸。外置后
 * 面板只留一行分发，本文件可独立阅读。
 *
 * ## 不变量（改之前先读）
 *   - **执行面只有一处**：落盘 = `zipImport.ts` 的 `copyAssetToRoot`（暂存 → 备份 →
 *     rename → 失败回滚 → 回滚失败转 `.recovery-`），本文件只做编排，**不碰 fs**；
 *   - **拷贝，不是同步**：复制后项目级与用户级是两份独立资产，任一侧后续变更都不传播；
 *   - **只受理项目级来源**：技能按聚合结果的 `layer === 'project'`，角色包按
 *     `isPathWithin(项目角色包根, filePath)`——防止把用户级资产「复制到它自己」；
 *   - 同名 = 显式覆盖（先备份、可回滚），取消时回执写明「未做任何写入」，**不静默跳过**。
 *
 * ## 射程边界（对外措辞）
 * 本轮只收回 LLM 的**正常工具路径**写权限；`run_code` / `run_skill_script` 等任意代码
 * 执行面仍不设防。回执与 UI 只可写「正常工具路径不再写用户目录」，不得写
 * 「模型无法写用户目录」。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { isPathWithin } from '../../extension/host/userAssets/path.js';
import {
  copyAssetToRoot,
  type OverwritePrompt,
} from '../../extension/host/userAssets/zipImport.js';
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
 * 同名覆盖确认（复制入口的唯一确认形态）
 *
 * @param prompt 执行面回传的目标信息（kind / name / 已存在的绝对路径）
 * @returns true = 覆盖；false = 取消（执行面据此返回「未做任何写入」）
 */
async function confirmCopyOverwrite(prompt: OverwritePrompt): Promise<boolean> {
  const label = prompt.kind === 'skill' ? '技能' : '角色包';
  const choice = await vscode.window.showWarningMessage(
    `用户级已存在同名${label}：${prompt.targetPath}\n继续会先备份现有内容再覆盖，失败自动回滚；确定复制？`,
    { modal: true },
    '覆盖',
    '取消',
  );
  return choice === '覆盖';
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
    postCopyError(deps, '技能系统或用户目录未就绪，无法复制到用户级');
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
    postCopyError(deps, `未找到项目级技能「${skillName}」，无法复制到用户级`);
    return;
  }

  const result = await copyAssetToRoot(skill.filePath, deps.userSkillsDir, {
    confirmOverwrite: confirmCopyOverwrite,
  });
  if (!result.ok) {
    postCopyError(deps, `复制到用户级失败：${result.reason}`);
    return;
  }
  // 回执必须写清「拷贝非同步」——否则用户会以为项目级改了用户级会跟着变
  deps.post({
    type: 'notice',
    level: 'info',
    message: `已复制技能「${skillName}」到用户级：${result.targetPath}（${result.fileCount} 个文件）。这是副本，不是同步——之后项目级与用户级互不影响。`,
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
    postCopyError(deps, '角色包系统或用户目录未就绪，无法复制到用户级');
    return;
  }
  // 来源归属以 filePath 为唯一判据，不猜来源；同名时内核池项目级优先，但仍逐路径核对
  const filePath = rpm.get(name)?.filePath;
  if (!filePath || !isPathWithin(deps.projectRolePacksDir, filePath)) {
    postCopyError(deps, `「${name}」不是项目级角色包，无法复制到用户级`);
    return;
  }

  const result = await copyAssetToRoot(filePath, deps.userRolePacksDir, {
    confirmOverwrite: confirmCopyOverwrite,
  });
  if (!result.ok) {
    postCopyError(deps, `复制到用户级失败：${result.reason}`);
    return;
  }
  deps.post({
    type: 'notice',
    level: 'info',
    message: `已复制角色包「${name}」到用户级：${result.targetPath}（${result.fileCount} 个文件）。这是副本，不是同步——之后项目级与用户级互不影响。`,
  });
  await refreshUserRolePacksFlow({
    agent,
    userRolePacksDir: deps.userRolePacksDir,
    post: deps.post,
    reloadList: deps.loadRoles,
  });
}
