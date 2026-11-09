/**
 * 角色徽章行（CHATVIEW-SLIM-3 第三刀·零状态批，自 chatView.ts 外置）
 *
 * 域职责：底部角色徽章行的两处 DOM 呈现——
 * ① team-meeting 图标按钮的**构造**（lazy 单例的引用与判据仍归 chatView 的 `updateTeamMeetingIcon`）；
 * ② 工具权限徽章（`#currentCapabilityBadge`）的文案 / 标题 / 显隐更新。
 *
 * **边界（与 `processFlowCells` 同一形态宪法）**：不持有状态、不注册全局监听、不启定时器
 * ⇒ 无 `dispose`；DOM 入口只经 deps 注入，禁在模块内读全局 `document`。
 *
 * @module roleBadgeView
 */

import * as l10n from '@vscode/l10n';
import { createIcon } from './icons.js';
import { CAPABILITY_STATE_TEXT } from '../helpers/capabilityLabels.js';
import type { CapabilityStateDto, RoleStrategyIndicatorDto } from '../../shared/protocol.js';

/**
 * 角色包回落差异文案（记录请求的包已不可用 ⇒ 徽章常驻标记）
 *
 * 单点原因：视觉后缀与读屏说明必须同源，各拼一份必漂移；空名 = 无差异，
 * 返回空串（调用方不必再判一次）。
 */
export function roleFallbackDiffText(name: string): { note: string; spoken: string } {
  return name
    ? {
        note: l10n.t('(the former "{0}" is unavailable)', name),
        spoken: '\n' + l10n.t('Role pack "{0}" is unavailable; the default role is in use', name),
      }
    : { note: '', spoken: '' };
}

/**
 * 角色徽章读屏标签（`aria-label` 优先于按钮内容 ⇒ 必须动态拼入角色名，写死会丢「现在是谁」）
 *
 * @param name   当前角色名
 * @param spoken 回落说明（`roleFallbackDiffText().spoken`，可为空）
 */
export function roleBadgeAria(name: string, spoken: string): string {
  return l10n.t('Current role: {0}{1}; click to manage role packs', name, spoken);
}

/**
 * 角色徽章可见文案：`角色名 · 首要特征`，回落差异后缀常驻（切走切回仍可见）
 *
 * @param name     当前角色名
 * @param topTrait 首要特征名（空串 = 无特征，只显示角色名）
 * @param note     回落差异后缀（来自 `roleFallbackDiffText().note`）
 */
export function roleBadgeText(name: string, topTrait: string, note: string): string {
  return topTrait ? `${name} · ${topTrait}${note}` : `${name}${note}`;
}

/** 单个特征得分串（「精准 60%」；百分数取整，避免徽章标题过长） */
export function traitScorePair(label: string, score: number): string {
  return l10n.t('{0} {1}%', label, String(Math.round(score * 100)));
}

/**
 * 角色徽章悬浮说明：角色名 + 全部特征得分 + 回落说明
 *
 * @param pairs  已格式化的特征得分串（`traitScorePair`）
 * @param spoken 回落说明（换行前缀由 `roleFallbackDiffText` 给）
 */
export function roleBadgeTitle(name: string, pairs: readonly string[], spoken: string): string {
  return l10n.t('Role: {0}\nTraits: {1}{2}', name, pairs.join(' · '), spoken);
}

/** 小组会议图标悬浮说明（组长 / 组员 / 点击提示） */
export function teamMeetingTitle(leader: string, members: readonly string[]): string {
  return l10n.t(
    'Team meeting · Leader: {0} · Members: {1} (click to start)',
    leader,
    members.join(' · '),
  );
}

/** 徽章行依赖：文档对象 + 两个徽章节点引用（节点身份由 chatView 持有，此处只读用） */
export interface RoleBadgeViewDeps {
  /** webview 文档对象（构造唯一 DOM 入口） */
  document: Document;
  /** 角色徽章节点（`#currentRoleBadge`）：team 图标插在其右侧 */
  roleBadge: HTMLElement | null;
  /** 能力徽章节点（`#currentCapabilityBadge`） */
  capabilityBadge: HTMLElement | null;
}

/** 徽章行窄接口：chatView 仅经此驱动 */
export interface RoleBadgeView {
  /** 构造 team-meeting 图标按钮并挂到 roleBadge 同行容器（调用方负责单例引用） */
  createTeamMeetingIcon(): HTMLElement;
  /**
   * 更新工具权限徽章（block → 「纯 LLM」；allow 按三态 → 全部工具 / 仅基础工具 / 能力列表）
   *
   * @param strategyHint 内核策略投影（只读模式等）。本视图**只做投影**，判定仍在
   *   内核 `toolReadonly` 一处；传 undefined 时输出与旧版逐字相同。
   */
  updateCapabilityBadge(
    toolMode: 'allow' | 'block',
    capabilityState: CapabilityStateDto,
    strategyHint?: RoleStrategyIndicatorDto,
  ): void;
  /**
   * 隐藏能力徽章（**仅草稿页投影归零用**，不代表「无能力面」的通用语义）
   *
   * 真实会话即使无激活角色包，能力面也是真实事实（如「全部工具」），不得隐藏；
   * 只有草稿页（无会话 ⇒ 无 Agent ⇒ 无能力面投影）才调用本方法。
   */
  hideCapabilityBadge(): void;
}

export function createRoleBadgeView(deps: RoleBadgeViewDeps): RoleBadgeView {
  const { document, roleBadge, capabilityBadge } = deps;

  /**
   * 创建 team-meeting 图标按钮（roleBadge 右侧，Trae 风格图标）。
   * 单例：仅由 updateTeamMeetingIcon 首次显示时调用一次；返回值存入 teamMeetingIcon。
   * 复用 icons.ts 统一图标管理，创建后挂到 roleBadge 同行容器。
   */
  function createTeamMeetingIcon(): HTMLElement {
    // 用 createIcon 创建按钮（Trae 统一图标管理，team 图标双人轮廓）
    const btn = createIcon('team', l10n.t('Team meeting (click to start)'), 'team-meeting-icon');
    // 插入 roleBadge 同行容器（roleBadge.parentNode 是底部徽章行）
    const container = roleBadge!.parentNode as HTMLElement;
    if (container) {
      // roleBadge 之后插入，跟在角色名右侧
      const refNode = roleBadge!.nextSibling;
      if (refNode) container.insertBefore(btn, refNode);
      else container.appendChild(btn);
    }
    // 点击：填充「小组会议：」前缀 + 聚焦 + 光标停在冒号后
    btn.addEventListener('click', () => {
      const input = document.getElementById('input') as HTMLTextAreaElement | null;
      if (!input) return;
      const PREFIX = l10n.t('Team meeting: ');
      input.value = PREFIX + input.value;
      input.focus();
      input.setSelectionRange(PREFIX.length, PREFIX.length);
    });
    // 键盘可达（Enter / Space 触发）
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        btn.click();
      }
    });
    return btn;
  }

  /**
   * 更新工具权限徽章（角色能力面可见性）
   *
   * 按 `capability_badge` 的 **已判定三态**渲染（本函数只分支，不判 length）：
   * - block 模式 → 显示「纯 LLM」标签
   * - allow + `all`（未声明）→ 显示「全部工具」
   * - allow + `residentOnly`（显式空）→ 显示「仅基础工具」（标题说明联网 / 代码执行已关）
   * - allow + `list`（白名单）→ 显示能力列表（如「文件」「联网」「记忆」）
   * - 任一 allow 三态 + `toolReadonly='readonly'` → 在既有文案后附加只读提示（不改三态语义）
   * 本函数只负责点亮与更新、不回置隐藏（「无数据」态即骨架初始 hidden）；
   * 唯一的隐藏入口是 `hideCapabilityBadge`（草稿页投影归零专用，见其注释）。
   */
  function updateCapabilityBadge(
    toolMode: 'allow' | 'block',
    capabilityState: CapabilityStateDto,
    strategyHint?: RoleStrategyIndicatorDto,
  ): void {
    if (!capabilityBadge) return;
    if (toolMode === 'block') {
      capabilityBadge.hidden = false;
      capabilityBadge.textContent = l10n.t('Pure LLM');
      capabilityBadge.title = l10n.t('Pure LLM mode (no tools are exposed)');
      return;
    }
    /** 只读提示文案：照内核事实陈述（`toolReadonly='readonly'` 时写类工具会被拒绝），不写承诺 */
    const READONLY_LABEL = l10n.t('Read-only mode (write tools are rejected)');
    /** 三态先定文案（本段不读 strategyHint，保证三态语义不被只读项干扰） */
    let label: string;
    let title: string;
    if (capabilityState.kind === 'all') {
      label = l10n.t(CAPABILITY_STATE_TEXT.all.label);
      title = l10n.t(CAPABILITY_STATE_TEXT.all.title);
    } else if (capabilityState.kind === 'residentOnly') {
      label = l10n.t(CAPABILITY_STATE_TEXT.residentOnly.label);
      title = l10n.t(CAPABILITY_STATE_TEXT.residentOnly.title);
    } else {
      // 能力名标签由 host 以英文源键下发，渲染侧统一过 l10n（host 与 webview 各用各的本地化器）
      const labels = [...new Set(capabilityState.capabilities.map((c) => l10n.t(c.label)))];
      label = labels.join(' · ');
      title = l10n.t('Allowed: {0}', labels.join(' · '));
    }
    // 只读是附加投影：三态文案与悬浮说明各追加一句，不替换、不重判
    if (strategyHint?.toolReadonly === 'readonly') {
      label = `${label} · ${READONLY_LABEL}`;
      title = l10n.t('{0} · {1}', title, READONLY_LABEL);
    }
    capabilityBadge.hidden = false;
    capabilityBadge.textContent = label;
    capabilityBadge.title = title;
  }

  /**
   * 隐藏能力徽章（草稿页 = 无会话 ⇒ 无能力面投影）
   *
   * 与 updateCapabilityBadge 的「有数据即显示」语义不冲突：本方法只在草稿投影里被调用，
   * 不在任何「无激活角色包」分支自动触发（那会把真实会话的能力事实藏起来）。
   */
  function hideCapabilityBadge(): void {
    if (!capabilityBadge) return;
    capabilityBadge.hidden = true;
    capabilityBadge.textContent = '';
    capabilityBadge.title = '';
  }

  return { createTeamMeetingIcon, updateCapabilityBadge, hideCapabilityBadge };
}
