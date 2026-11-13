/**
 * 角色列表投影 —— 聊天页 / 设置页共用的角色列表消息构造点
 *
 * 为什么外置：`settingsPanel.ts`、`chatPanel.ts` 均已贴 eslint `max-lines` 只降不升基线；
 * 本段是**纯投影**（输入 rpm（+ 会话记录名）→ 一条消息），无面板状态、无写盘。
 *
 * 判据全部来自既有点，本模块不另写：
 *   - 包清单 / 策略 / 校验问题 ← 内核 `rolePackManager`
 *   - 来源层 ← 调用方注入的 `rolePackSource`（与保存链路内置拒绝判据同源）
 *   - 队伍健康 ← `inspectRolePackTeams`；组名单 ← globalState（只读）
 *   - 当前角色：草稿显式值优先；真实会话保持既有回落链（`activeName ?? packs[0]`）
 */
import type * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { BUILTIN_FALLBACK_PACK, MAX_TEAM_MEMBERS, describeStrategyKeys } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { ROLE_PACK_TEAMS_KEY } from '../../shared/constants.js';
import { inspectRolePackTeams } from '../../extension/host/rolePackTeams.js';
import { deriveCapabilityState } from './capabilityState.js';

/** 投影所需的宿主面（全部由调用方注入；本模块不持有面板实例） */
export interface RolePackListContext {
  /** 投递到 webview（走面板既有 post，含后台流闸） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 组（会议名单）用户级数据（只读；写入仍归 roles_team_save / roles_team_delete） */
  globalState: vscode.Memento | undefined;
  /** 来源层单点判定（调用方与保存链路共用同一判据，禁在此另写前缀副本） */
  rolePackSource: (filePath: string | undefined) => 'builtin' | 'user' | 'project';
}

/**
 * 发送 `roles_loaded`（角色列表 + 当前角色 + 队伍健康 + 键面）
 *
 * @param ctx 宿主面（post / globalState / 来源判定）
 * @param rpm 角色包管理器（undefined = 目录不可得：如实空列表，不伪造条目）
 * @param draftActiveName 草稿期「当前角色」显式值（未选时 = 内核兜底包；真实会话传 undefined）
 * @param defaultName 用户级「新建会话默认角色包」名（空串 = 未设置；只作「默认」徽章数据源）
 */
export function postRolePackList(
  ctx: RolePackListContext,
  rpm: Agent['rolePackManager'] | undefined,
  draftActiveName?: string,
  defaultName = '',
): void {
  if (!rpm) {
    ctx.post({
      type: 'roles_loaded',
      packs: [],
      teams: [],
      // 草稿仍有「当前角色」事实（内核兜底包）；真实会话未就绪时保持空串
      activeName: draftActiveName ?? '',
      defaultName,
      maxTeamMembers: MAX_TEAM_MEMBERS,
      // 键面与 rpm 无关（静态派生），未就绪时也下发，编辑模式不因装配时序缺席
      keyface: describeStrategyKeys(),
    });
    return;
  }
  // 读期健康检测（唯一接线点，只读不写回）：对照包池算出每支队伍的受损状态
  // （组长失效=遗留队伍 / 组员失效=缺员），随 teams 下发供角色页持久标注；
  // 「清理/修复」由用户主动触发（roles_team_delete / roles_team_save），宿主不静默改用户数据。
  const teamHealth = inspectRolePackTeams(rpm, ctx.globalState);
  // 组（会议名单）用户级数据：组员仅作小组会议参与者
  const teams = (
    ctx.globalState?.get<{ leader: string; members: string[] }[]>(ROLE_PACK_TEAMS_KEY) ?? []
  ).map((t) => {
    // 检测视图附加（读期派生，不落盘）：健康组不带标记字段，存量 webview 兼容旧载荷
    const health = teamHealth.get(t.leader);
    return health && (health.leaderMissing || health.missingMembers.length > 0)
      ? { ...t, leaderMissing: health.leaderMissing, missingMembers: health.missingMembers }
      : t;
  });
  const packs = rpm
    .listMeta()
    .filter((m) => m.name)
    .map((m) => {
      const pack = rpm.get(m.name);
      // 来源层判定：rolePackSource 单点（与保存链路内置拒绝判据同源，禁第二份前缀副本）
      const source = ctx.rolePackSource(pack?.filePath);
      // 提取策略指示器：从内核完整策略中提炼 UI 友好的摘要
      const strategy = pack?.strategy;
      // 温度分组：基于 temperature 值动态计算
      const temp = strategy?.act?.temperature ?? 0.7;
      const tempGroup = temp >= 0.8 ? 'high' : temp <= 0.4 ? 'low' : 'mid';
      const strategyHint = strategy
        ? {
            toolReadonly: strategy.act?.toolReadonly,
            tempGroup: tempGroup as 'high' | 'mid' | 'low',
            reasoningMode: strategy.act?.multiStepReasoning as 'auto' | 'manual' | undefined,
            summaryFocus: strategy.prepare?.summaryFocus,
            outputLimit: strategy.act?.outputLimit,
          }
        : undefined;
      return {
        name: m.name,
        displayName: m.displayName ?? m.name,
        source,
        description: m.description ?? '',
        // 三态判定走 capabilityState.deriveCapabilityState 单点（CAP-TRISTATE-1）：这里只透传结果，不自行判 length
        capabilityState: deriveCapabilityState(pack?.capabilities),
        traits: pack?.traits,
        handoffPrompt: pack?.meta.handoffPrompt,
        strategyHint,
        interactionType: pack?.meta.interactionType,
        version: pack?.meta.version,
        // 兜底契约包禁删标记（组员反向索引已退役：组员不感知被引用，见 ADR-028 收敛补记）
        isFallback: m.name === BUILTIN_FALLBACK_PACK,
        // 健康徽章：内核装配期的校验 issues 全量透传给 webview（error/warning 均渲染）
        issues: (pack?.validationIssues ?? []).map((i) => ({
          level: i.severity,
          message: i.message,
        })),
      };
    });
  // 草稿：显式值优先（绝不用 packs[0] 兜成「当前」）；真实会话：保持既有回落链不变
  const activeName = draftActiveName ?? rpm.activeName ?? (packs.length > 0 ? packs[0]!.name : '');
  ctx.post({
    type: 'roles_loaded',
    packs,
    teams,
    activeName,
    defaultName,
    // maxTeamMembers / keyface：内核常量与键面透传（UI 侧禁另写字面量 / 清单）
    maxTeamMembers: MAX_TEAM_MEMBERS,
    keyface: describeStrategyKeys(),
  });
}

/**
 * 聊天页角色选择器投影（`chat_role_packs` 载荷）
 *
 * 轻量列表（name / displayName / description），与设置页 `roles_loaded` 共用同一 `listMeta` 真源；
 * `unavailableName` 只由「会话记录请求名 ≠ 实际激活名」派生，不另存第二份状态。
 *
 * @param rpm 角色包管理器（undefined = 尚未装配：空列表让 webview 隐藏选择器）
 * @param requested 会话 meta 记录的角色名（undefined = 该会话从未选过）
 */
export function buildChatRolePacks(
  rpm: Agent['rolePackManager'] | undefined,
  requested: string | undefined,
): ExtensionToWebviewMessage {
  if (!rpm) {
    return { type: 'chat_role_packs', packs: [], activeName: '', unavailableName: requested };
  }
  const packs = rpm
    .listMeta()
    .filter((p) => p.name) // 过滤无 name 的异常包
    .map((p) => ({
      name: p.name,
      displayName: p.displayName ?? p.name,
      description: p.description ?? '',
    }));
  // 缺省回退首个（与内核「默认激活首个」一致）；无角色包时为空串
  const activeName = rpm.activeName ?? (packs.length > 0 ? packs[0]!.name : '');
  const unavailableName = requested && requested !== activeName ? requested : undefined;
  return { type: 'chat_role_packs', packs, activeName, unavailableName };
}
