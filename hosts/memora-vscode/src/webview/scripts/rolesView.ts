/**
 * rolesView — 角色子视图 webview 运行时脚本（阶段 B P2-1 模式，2026-08-17）
 *
 * 由 settingsView.ts 挂载（设置视图选项卡合并后角色子视图）：以工厂函数 createRolesView
 * 接收依赖（vscode / window / root）并初始化全部交互，替代「字符串注入脚本」。
 *
 * 职责：
 *   - 渲染角色包卡片列表（激活徽章 + 定位描述 + 能力标签 chips）；
 *   - 「设为当前」→ postMessage roles_set_active（host 切换 + 持久化 + 重推）；
 *   - 监听 roles_loaded 渲染（host resolve 时推送 + 切换后重推）。
 *
 * 由 esbuild 以 browser/iife 打包进 dist/webview/scripts/settingsView.js（经 settingsViewMain
 * 入口），在 webview HTML 中 <script src> 引用（CSP script-src cspSource）。
 */
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { createEmptyState, createGroupTitle } from '../helpers/cardList.js';

/** rolesView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface RolesViewDeps {
  /** webview 通信 API（SSOT：由 settingsView 统一 acquireVsCodeApi() 一次后注入，
   *  子视图不再各自调用——acquireVsCodeApi 每个 webview 只能调用一次） */
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
  /** 子视图挂载根容器（设置视图选项卡合并后：查询限定在根内，多子视图 id 空间隔离） */
  root: HTMLElement;
}

/** 角色列表加载完成载荷（roles_loaded）的最小结构 */
interface RolesPayload {
  packs: {
    name: string;
    displayName: string;
    description?: string;
    capabilities: { capability: string; label: string }[];
    traits?: Record<string, number>;
    handoffPrompt?: string;
    strategyHint?: {
      toolReadonly?: 'readonly' | 'full';
      toolApproval?: 'confirm' | 'auto';
      tempGroup?: 'high' | 'mid' | 'low';
      reasoningMode?: 'auto' | 'manual';
      summaryFocus?: string;
      outputLimit?: number;
    };
    interactionType?: 'tool_assistant' | 'companion';
    version?: string;
    /** 该角色包作为组员被哪些组引用（仅小组会议用，标注展示） */
    teamMembers?: readonly string[];
    /** 兜底契约包标记（BUILTIN_FALLBACK_PACK，宿主 UI 禁删） */
    isFallback?: boolean;
  }[];
  /** 组（会议名单）：组长 + 组员（v0.13 S7） */
  teams: { leader: string; members: string[] }[];
  activeName: string;
}

/**
 * 初始化角色管理面板 webview 交互
 *
 * @param deps 运行时依赖（vscode 通信实例 + window + root）
 */
export function createRolesView({ vscode, window, root }: RolesViewDeps): void {
  const document = window.document;
  // id 空间隔离：查询限定在 root 容器内（设置视图合并后与 config/memory 子视图共存，
  // 各自根内都有 #list/#statBar，不做根内查询会冲突）
  const list = root.querySelector('#list') as HTMLElement;
  const statBar = root.querySelector('#statBar') as HTMLElement;

  let activeName: string | undefined;

  /** 渲染角色包列表：激活角色置顶高亮，其余按序展示（对齐 config 面板分组） */
  function render(data: RolesPayload): void {
    statBar.hidden = false;
    statBar.textContent = `已加载 ${data.packs?.length ?? 0} 个角色`;
    list.textContent = '';
    // 小组会议区（组 = 组长角色包的会议名单，v0.13 S7）——置顶展示 + 建组入口
    list.appendChild(buildTeamSection(data));
    if (!data.packs || data.packs.length === 0) {
      // 空态引导：无角色包时提示（SSOT：createEmptyState 纯函数，对齐 configView 列表级同构）
      list.appendChild(
        createEmptyState(document, {
          title: '暂无角色包',
          hint: '请先打开一个工作区，或安装角色包后重新加载',
        }),
      );
      return;
    }
    activeName = data.activeName;
    // 激活角色置顶（主动可见：用户一眼看到当前定位）
    const active = data.packs.filter((p) => p.name === activeName);
    if (active.length > 0) {
      list.appendChild(createGroupTitle(document, '当前角色'));
      active.forEach((p) => list.appendChild(buildCard(p)));
    }
    const others = data.packs.filter((p) => p.name !== activeName);
    if (others.length > 0) {
      list.appendChild(createGroupTitle(document, '其他角色'));
      others.forEach((p) => list.appendChild(buildCard(p)));
    }
  }

  /**
   * 小组会议区（v0.13 S7）：组 = 组长角色包的会议名单（非选择对象）。
   * 展示既有小组（组长 + 组员名单，成员标注「小组会议用」）+ 建组/删除入口；
   * 会议定位提示：用户发起"小组会议"后，LLM 用任务表组织逐成员发言（内核已注入组清单）。
   */
  function buildTeamSection(data: RolesPayload): HTMLElement {
    const section = document.createElement('section');
    section.className = 'team-section';

    const header = document.createElement('div');
    header.className = 'team-header';
    const title = document.createElement('span');
    title.className = 'team-title';
    title.textContent = '小组会议';
    header.appendChild(title);
    const hint = document.createElement('span');
    hint.className = 'team-hint';
    hint.textContent = '组员仅作会议参与者（表层装配发言），不用于日常切换';
    header.appendChild(hint);
    section.appendChild(header);

    const teams = data.teams ?? [];
    if (teams.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'team-empty';
      empty.textContent = '暂无小组。建组后，以组长为当前角色时说「小组会议，讨论 XX」，即可让组员从各自视角发言。';
      section.appendChild(empty);
    } else {
      for (const team of teams) {
        section.appendChild(buildTeamCard(team, data));
      }
    }

    // 建组入口：选择组长 + 勾选组员 → 保存
    const createBtn = document.createElement('button');
    createBtn.className = 'btn btn-secondary team-create';
    createBtn.textContent = '＋ 新建小组';
    createBtn.addEventListener('click', () => {
      if (section.querySelector('.team-form')) {
        section.querySelector('.team-form')?.remove();
        return;
      }
      section.appendChild(buildTeamForm(data));
    });
    section.appendChild(createBtn);
    return section;
  }

  /** 单个小组卡片：组长 + 组员名单（组员标注「会议参与」）+ 删除 */
  function buildTeamCard(
    team: { leader: string; members: string[] },
    data: RolesPayload,
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'team-card';
    const leaderName = data.packs.find((p) => p.name === team.leader)?.displayName ?? team.leader;
    const head = document.createElement('div');
    head.className = 'team-card-head';
    const label = document.createElement('span');
    label.className = 'team-leader';
    label.textContent = `组长：${leaderName}`;
    head.appendChild(label);
    const del = document.createElement('button');
    del.className = 'btn btn-danger team-del';
    del.textContent = '删除';
    del.title = '删除该小组（仅影响会议名单，不影响角色日常使用）';
    del.addEventListener('click', () => {
      vscode.postMessage({ type: 'roles_team_delete', leader: team.leader });
    });
    head.appendChild(del);
    card.appendChild(head);
    const members = document.createElement('div');
    members.className = 'team-members';
    team.members.forEach((m) => {
      const name = data.packs.find((p) => p.name === m)?.displayName ?? m;
      const tag = document.createElement('span');
      tag.className = 'team-member-tag';
      tag.textContent = name;
      tag.title = `${name}（小组会议参与者）`;
      members.appendChild(tag);
    });
    card.appendChild(members);
    return card;
  }

  /** 建组表单：组长下拉 + 组员多选（UI 层排除组长 + host 层硬校验兜底，双层防护） */
  function buildTeamForm(data: RolesPayload): HTMLElement {
    const form = document.createElement('div');
    form.className = 'team-form';
    const packs = data.packs ?? [];

    // 组长选择
    const leaderRow = document.createElement('label');
    leaderRow.className = 'team-form-row';
    leaderRow.textContent = '组长：';
    const leaderSel = document.createElement('select');
    leaderSel.className = 'team-select';
    packs.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.displayName + (p.isFallback ? '（兜底）' : '');
      leaderSel.appendChild(opt);
    });
    leaderRow.appendChild(leaderSel);
    form.appendChild(leaderRow);

    // 组员多选（checkbox 列表）：排除当前组长，组长切换时动态刷新
    const membersRow = document.createElement('div');
    membersRow.className = 'team-form-row team-members-pick';
    membersRow.textContent = '组员：';
    const pickList = document.createElement('div');
    pickList.className = 'team-pick-list';

    /** 渲染组员 pick 列表，排除指定组长 */
    function renderMemberPick(excludeLeader: string): void {
      pickList.innerHTML = '';
      packs
        .filter((p) => p.name !== excludeLeader)
        .forEach((p) => {
          const item = document.createElement('label');
          item.className = 'team-pick-item';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = p.name;
          item.appendChild(cb);
          const txt = document.createElement('span');
          txt.textContent = p.displayName + (p.isFallback ? '（兜底）' : '');
          item.appendChild(txt);
          pickList.appendChild(item);
        });
    }
    renderMemberPick(leaderSel.value);
    // 组长切换 → 组员列表排除新组长，已勾选旧组长的项不会出现（被过滤掉）
    leaderSel.addEventListener('change', () => renderMemberPick(leaderSel.value));

    membersRow.appendChild(pickList);
    form.appendChild(membersRow);

    const actions = document.createElement('div');
    actions.className = 'team-form-actions';
    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.textContent = '保存小组';
    save.addEventListener('click', () => {
      const leader = leaderSel.value;
      const members = Array.from(pickList.querySelectorAll('input:checked')).map(
        (el) => (el as HTMLInputElement).value,
      );
      vscode.postMessage({ type: 'roles_team_save', leader, members });
    });
    actions.appendChild(save);
    form.appendChild(actions);
    return form;
  }

  /**
   * 构建单个角色包卡片（紧凑堆叠布局）
   *
   * 布局结构（三层分类法）：
   *   - 顶部标题行（一级直面）：图标 + 名称 + 当前/兜底标签 + 操作按钮
   *   - 中部信息区（次级信息）：描述 + 能力标签 + 策略指示器 + 组员标注
   *   - 底部折叠区（专家挖掘）：性格特征 + 版本号
   */
  function buildCard(p: RolesPayload['packs'][number]): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card' + (p.name === activeName ? ' active' : '');

    // ===== 顶部标题行（一级直面）=====
    const header = document.createElement('div');
    header.className = 'card-header';

    // 卡片图标：角色显示名首字（紧凑尺寸 24x24）
    const icon = document.createElement('div');
    icon.className = 'role-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = p.displayName.charAt(0);
    header.appendChild(icon);

    // 角色名 + 当前标签
    const nameEl = document.createElement('span');
    nameEl.className = 'card-name';
    nameEl.textContent = p.displayName;
    header.appendChild(nameEl);

    if (p.name === activeName) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '当前';
      header.appendChild(badge);
    }
    // 兜底标记已合并至下方策略区的「系统兜底」chip（避免重复，2026-08-29 实测反馈）

    // 操作按钮（右侧，margin-left: auto）
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    // 「带入对话」：所有角色均可一键切换并跳转到对话
    const handoffBtn = document.createElement('button');
    handoffBtn.className = 'btn btn-primary';
    handoffBtn.textContent = '带入对话';
    handoffBtn.title = '切换角色并跳到对话视图：已在输入框预填一句过渡语（不自动发送，可编辑后再发）';
    handoffBtn.addEventListener('click', () =>
      vscode.postMessage({ type: 'roles_handoff', name: p.name }),
    );
    actions.appendChild(handoffBtn);

    // 「设为当前」：仅非激活角色展示
    if (p.name !== activeName) {
      const actBtn = document.createElement('button');
      actBtn.className = 'btn btn-secondary';
      actBtn.textContent = '设为当前';
      actBtn.title = '仅切换默认角色，停留在设置页（不跳转到对话）';
      actBtn.addEventListener('click', () =>
        vscode.postMessage({ type: 'roles_set_active', name: p.name }),
      );
      actions.appendChild(actBtn);
    }
    header.appendChild(actions);
    card.appendChild(header);

    // ===== 中部信息区（次级信息）=====
    const info = document.createElement('div');
    info.className = 'card-info';

    // 定位描述（manifest.description，可选，2 行截断）
    if (p.description) {
      const desc = document.createElement('div');
      desc.className = 'card-detail';
      desc.textContent = p.description;
      info.appendChild(desc);
    }

    // 能力标签 chips（紧凑单行）
    if (p.capabilities && p.capabilities.length > 0) {
      const caps = document.createElement('div');
      caps.className = 'cap-chips';
      p.capabilities.forEach((c) => {
        const chip = document.createElement('span');
        chip.className = 'cap-chip';
        chip.textContent = c.label;
        chip.title = c.capability;
        caps.appendChild(chip);
      });
      info.appendChild(caps);
    }

    // 策略指示器 + 兜底定位（紧凑单行）：完整工具/自动执行/平衡等策略 chips + 「系统兜底」chip（isFallback）
    if (p.strategyHint || p.isFallback) {
      const strategy = document.createElement('div');
      strategy.className = 'role-strategy';
      const hint = p.strategyHint;

      if (hint?.toolReadonly) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip ' + (hint.toolReadonly === 'readonly' ? 'readonly' : 'full');
        chip.textContent = hint.toolReadonly === 'readonly' ? '只读模式' : '完整工具';
        strategy.appendChild(chip);
      }
      if (hint?.toolApproval) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip ' + (hint.toolApproval === 'confirm' ? 'confirm' : 'auto');
        chip.textContent = hint.toolApproval === 'confirm' ? '需审批' : '自动执行';
        strategy.appendChild(chip);
      }
      if (hint?.tempGroup) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip temp-' + hint.tempGroup;
        const tempLabel = { high: '高创意', mid: '平衡', low: '低温度' };
        chip.textContent = tempLabel[hint.tempGroup] ?? hint.tempGroup;
        strategy.appendChild(chip);
      }
      if (hint?.reasoningMode) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip reasoning-' + hint.reasoningMode;
        chip.textContent = hint.reasoningMode === 'auto' ? '自动推理' : '手动推理';
        strategy.appendChild(chip);
      }
      if (hint?.summaryFocus) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip';
        chip.textContent = `聚焦: ${hint.summaryFocus}`;
        strategy.appendChild(chip);
      }
      if (hint?.outputLimit && hint.outputLimit > 0) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip output-limit';
        chip.textContent = `输出上限: ${hint.outputLimit}k`;
        strategy.appendChild(chip);
      }
      // 兜底契约包定位（能力标签区，2026-08-29 实测反馈）：以 chip 呈现系统兜底，
      // 替代描述区的长开发说明（manifest.description 已精简，机制说明移入 title）
      if (p.isFallback) {
        const chip = document.createElement('span');
        chip.className = 'strategy-chip fallback';
        chip.textContent = '系统兜底';
        chip.title =
          '内核兜底契约包（BUILTIN_FALLBACK_PACK）：领域无关通用助手，名字锁定、系统内置不可删除、构建期校验';
        strategy.appendChild(chip);
      }

      if (strategy.children.length > 0) {
        info.appendChild(strategy);
      }
    }

    // 组员标注（v0.13 S7）：该角色包被哪些组引用为组员——仅小组会议参与者，不用于日常切换
    if (p.teamMembers && p.teamMembers.length > 0) {
      const memberTag = document.createElement('div');
      memberTag.className = 'team-member-role';
      memberTag.textContent = `小组会议用（组员：${p.teamMembers.join(' / ')}）`;
      memberTag.title = '作为组员参与小组会议（会议内表层装配发言），不参与日常切换';
      info.appendChild(memberTag);
    }

    card.appendChild(info);

    // ===== 底部折叠区（专家挖掘）=====
    const hasTraits = p.traits && Object.keys(p.traits).length > 0;
    const hasVersion = !!p.version;

    if (hasTraits || hasVersion) {
      const details = document.createElement('details');
      details.className = 'card-details';

      const summary = document.createElement('summary');
      summary.textContent = '详情';
      details.appendChild(summary);

      const content = document.createElement('div');
      content.className = 'details-content';

      // 性格特征 (Traits)
      if (hasTraits) {
        const traits = document.createElement('div');
        traits.className = 'role-traits';
        const labelMap: Record<string, string> = {
          precision: '精准',
          creativity: '创意',
          rigor: '严谨',
          empathy: '共情',
          speed: '速度',
        };
        Object.entries(p.traits!).forEach(([key, value]) => {
          const trait = document.createElement('div');
          trait.className = 'trait';
          const label = document.createElement('span');
          label.className = 'trait-label';
          label.textContent = labelMap[key] ?? key;
          const bar = document.createElement('div');
          bar.className = 'trait-bar';
          const fill = document.createElement('div');
          fill.className = 'trait-fill';
          fill.style.width = `${Math.round(value * 100)}%`;
          fill.title = `${label.textContent}: ${value.toFixed(2)}`;
          bar.appendChild(fill);
          trait.appendChild(label);
          trait.appendChild(bar);
          traits.appendChild(trait);
        });
        content.appendChild(traits);
      }

      // 版本号
      if (hasVersion) {
        const ver = document.createElement('div');
        ver.className = 'card-version';
        ver.textContent = `v${p.version}`;
        content.appendChild(ver);
      }

      details.appendChild(content);
      card.appendChild(details);
    }

    return card;
  }

  // 消息接收：roles_loaded 渲染列表
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'roles_loaded') render(msg);
  });
}
