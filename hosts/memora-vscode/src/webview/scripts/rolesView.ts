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
    // ② 卡片级组队（2026-08-29）：小组信息以角色包卡片为单位呈现（卡片底部 team-ribbon），
    // 不再有独立顶部小组会议区——组队入口/阵容/删除均落在各角色包卡片上（SSOT：组数据契约不变）
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
      active.forEach((p) => list.appendChild(buildCard(p, data)));
    }
    const others = data.packs.filter((p) => p.name !== activeName);
    if (others.length > 0) {
      list.appendChild(createGroupTitle(document, '其他角色'));
      others.forEach((p) => list.appendChild(buildCard(p, data)));
    }
  }

  /**
   * ② 卡片级小组条（以角色包为单位组队）：卡片底部展示该角色包的队伍阵容 + 组队/编辑入口。
   * 缺省显示「暂无队伍」；组数据契约 { leader, members } 不变（复用 roles_team_save/delete）。
   */
  function buildTeamRibbon(p: RolesPayload['packs'][number], data: RolesPayload): HTMLElement {
    const ribbon = document.createElement('div');
    ribbon.className = 'team-ribbon';
    const label = document.createElement('span');
    label.className = 'team-ribbon-label';
    const leadTeam = data.teams?.find((t) => t.leader === p.name);
    if (leadTeam) {
      const names = leadTeam.members
        .map((m) => data.packs.find((x) => x.name === m)?.displayName ?? m)
        .join(' / ');
      label.textContent = `队伍：${names}`;
      label.title = `${leadTeam.members.length} 名组员参与小组会议（表层装配发言）`;
    } else {
      label.textContent = '暂无队伍';
    }
    const action = document.createElement('button');
    action.className = 'btn btn-secondary team-ribbon-btn';
    action.textContent = leadTeam ? '编辑队伍' : '创建队伍';
    action.title = leadTeam
      ? '修改队伍组员（5 人组上限：队长 1 + 组员 ≤ 4）'
      : '以当前角色为队长创建队伍（5 人组上限：队长 + 组员 ≤ 5）';
    action.addEventListener('click', () => launchTeamModal(p, data));
    ribbon.appendChild(label);
    ribbon.appendChild(action);
    return ribbon;
  }

  /**
   * ② 卡片组队弹窗（以卡片为单位）：电话本式勾选除当前队长外的所有角色（最多 4 名组员，5 人组上限）。
   * 编辑既有队伍时回显已选组员；复用 roles_team_save 保存契约。
   * 默认保留「当前角色已是别队成员」的共享说明（内核当前无互斥限制，组员可复用）。
   */
  function launchTeamModal(p: RolesPayload['packs'][number], data: RolesPayload): void {
    const overlay = document.createElement('div');
    overlay.className = 'team-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'team-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', `为「${p.displayName}」创建队伍`);

    const head = document.createElement('div');
    head.className = 'team-modal-head';
    const title = document.createElement('span');
    title.className = 'team-modal-title';
    title.textContent = `创建队伍 · 队长 ${p.displayName}`;
    const close = document.createElement('button');
    close.className = 'btn team-modal-close';
    close.textContent = '×';
    close.title = '关闭';
    close.addEventListener('click', () => overlay.remove());
    head.appendChild(title);
    head.appendChild(close);
    modal.appendChild(head);

    const current = data.teams?.find((t) => t.leader === p.name);
    const selected = new Set(current?.members ?? []);
    const LIMIT = 4; // 5 人组上限的组员部分

    const list = document.createElement('div');
    list.className = 'team-modal-list';
    const picks = data.packs.filter((x) => x.name !== p.name);
    for (const x of picks) {
      const item = document.createElement('label');
      item.className = 'team-modal-item' + (selected.has(x.name) ? ' checked' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = x.name;
      cb.checked = selected.has(x.name);
      const txt = document.createElement('span');
      txt.textContent = x.displayName + (x.isFallback ? '（兜底）' : '');
      item.appendChild(cb);
      item.appendChild(txt);
      // 已达 5 人上限（4 名组员）时禁止继续勾选；取消勾选始终允许
      cb.addEventListener('change', () => {
        if (cb.checked && list.querySelectorAll('input:checked').length > LIMIT) {
          cb.checked = false;
          return;
        }
        item.classList.toggle('checked', cb.checked);
      });
      // 整行点击切换（行为对齐 checkbox 语义，可访问性由原 checkbox 承担）
      item.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).tagName !== 'INPUT') cb.click();
      });
      list.appendChild(item);
    }
    modal.appendChild(list);

    // 反馈区：5 人上限提示（默认）+ 当前角色已是别队成员时的共享说明
    const hint = document.createElement('div');
    hint.className = 'team-modal-hint';
    const sharedLeader = data.teams?.find((t) => t.leader !== p.name && t.members.includes(p.name));
    hint.textContent = !sharedLeader
      ? '5 人组上限：队长 1 + 组员 ≤ 4（勾选超过 4 名自动拒绝）'
      : `当前角色已作为「${sharedLeader.leader}」的队伍成员参与会议；创建自己队伍后仍保留原参与。`;
    modal.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'team-modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => overlay.remove());
    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.textContent = current ? '保存队伍' : '创建队伍';
    save.addEventListener('click', () => {
      const members = Array.from(list.querySelectorAll('input:checked')).map(
        (el) => (el as HTMLInputElement).value,
      );
      vscode.postMessage({ type: 'roles_team_save', leader: p.name, members });
      overlay.remove();
    });
    actions.appendChild(cancel);
    actions.appendChild(save);
    // ② 编辑态删除队伍：仅当已有队伍时提供（解散队伍 = 移除会议名单，不影响角色日常）
    if (current) {
      const del = document.createElement('button');
      del.className = 'btn btn-danger team-modal-del';
      del.textContent = '删除队伍';
      del.title = '解散该队伍（移除会议名单，不影响任何角色日常使用）';
      del.addEventListener('click', () => {
        vscode.postMessage({ type: 'roles_team_delete', leader: p.name });
        overlay.remove();
      });
      actions.appendChild(del);
    }
    modal.appendChild(actions);

    // 点击遮罩空白处关闭
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) overlay.remove();
    });
    overlay.appendChild(modal);
    document.getElementById('roles-root')?.appendChild(overlay);
  }

  /**
   * 构建单个角色包卡片（紧凑堆叠布局）
   *
   * 布局结构（三层分类法）：
   *   - 顶部标题行（一级直面）：图标 + 名称 + 当前/兜底标签 + 操作按钮
   *   - 中部信息区（次级信息）：描述 + 能力标签 + 策略指示器 + 组员标注
   *   - 卡片级小组条（二级信息）：队伍阵容 + 创建/编辑队伍入口
   *   - 底部折叠区（专家挖掘）：性格特征 + 版本号
   */
  function buildCard(p: RolesPayload['packs'][number], data: RolesPayload): HTMLElement {
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

    // ② 卡片级小组条（队伍状态 + 组队入口；复用小组成员标注的信息层级）
    card.appendChild(buildTeamRibbon(p, data));

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
