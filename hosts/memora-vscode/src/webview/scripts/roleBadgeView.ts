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

import { createIcon } from './icons.js';
import type { CapabilityStateDto } from '../../shared/protocol.js';

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
  /** 更新工具权限徽章（block → 「纯 LLM」；allow 按三态 → 全部工具 / 仅基础工具 / 能力列表） */
  updateCapabilityBadge(toolMode: 'allow' | 'block', capabilityState: CapabilityStateDto): void;
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
    const btn = createIcon('team', '小组会议（点击启动）', 'team-meeting-icon');
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
      const PREFIX = '小组会议：';
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
   * 无隐藏分支：「无数据」态即骨架初始 hidden（未收到 capability_badge 前不亮），
   * 本函数只负责点亮与更新，不回置隐藏。
   */
  function updateCapabilityBadge(
    toolMode: 'allow' | 'block',
    capabilityState: CapabilityStateDto,
  ): void {
    if (!capabilityBadge) return;
    if (toolMode === 'block') {
      capabilityBadge.hidden = false;
      capabilityBadge.textContent = '纯 LLM';
      capabilityBadge.title = '纯 LLM 模式（无工具暴露）';
      return;
    }
    if (capabilityState.kind === 'all') {
      capabilityBadge.hidden = false;
      capabilityBadge.textContent = '全部工具';
      capabilityBadge.title = '允许所有工具（角色包未声明能力白名单）';
      return;
    }
    if (capabilityState.kind === 'residentOnly') {
      capabilityBadge.hidden = false;
      capabilityBadge.textContent = '仅基础工具';
      capabilityBadge.title =
        '仅基础工具：角色包声明了空能力白名单（联网、代码执行等特权工具已关闭）';
      return;
    }
    const labels = [...new Set(capabilityState.capabilities.map((c) => c.label))];
    capabilityBadge.hidden = false;
    capabilityBadge.textContent = labels.join(' · ');
    capabilityBadge.title = `允许：${labels.join('、')}`;
  }

  return { createTeamMeetingIcon, updateCapabilityBadge };
}
