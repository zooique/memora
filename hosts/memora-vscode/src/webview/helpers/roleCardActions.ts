/**
 * 角色卡顶部控件（状态徽章 + 操作按钮）的 DOM 构造（**纯构造，无面板状态**）
 *
 * 为什么外置：rolesView.ts 贴 max-lines 1000 红线（HOST-SPLIT-1），而本段是
 * 「当前 / 默认」两个层面文案的集中地——散在千行长文件里最容易被误改或复制出第二份。
 *
 * 语义边界（两个层面互不代替，可同时成立）：
 *   - 「当前」= 本会话的激活角色（`roles_set_active` 缺省 scope，只改该会话）；
 *   - 「默认」= 用户级配置 `memora.defaultRolePack`（`roles_set_active` + `scope:'default'`，
 *     只影响此后新建会话；同一通道两种作用域，不另开 op）。
 */
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import { appendPromoteToUserButton } from './assetPromoteButton.js';

/** 角色卡投影的最小读面（`roles_loaded.packs` 元素的子集） */
export interface RoleCardPack {
  name: string;
  /** 来源层（project 时提供「拷贝到用户级」入口） */
  source?: 'builtin' | 'user' | 'project';
}

/** 控件构造依赖（由 rolesView 注入） */
export interface RoleCardControlDeps {
  document: Document;
  /** webview → extension 投递器（与 settingsView 共用同一实例） */
  post(message: WebviewToExtensionMessage): void;
  /** 当前会话激活角色（undefined = 无激活） */
  activeName: string | undefined;
  /** 用户级默认角色名（空串 = 未设置） */
  defaultName: string;
}

/**
 * 追加状态徽章（当前 / 默认）
 *
 * @param deps 视图依赖
 * @param header 卡片标题行容器
 * @param pack 卡片对应的角色包
 */
export function appendRoleStateBadges(
  deps: RoleCardControlDeps,
  header: HTMLElement,
  pack: RoleCardPack,
): void {
  const { document } = deps;
  if (pack.name === deps.activeName) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '当前';
    header.appendChild(badge);
  }
  // 「默认」徽章：新建会话将自动使用该角色（与「当前」是两个层面，可同时成立）
  if (pack.name === deps.defaultName) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '默认';
    badge.title = '新建会话将自动使用该角色；不影响已有会话';
    header.appendChild(badge);
  }
}

/**
 * 追加操作按钮（带入对话 / 拷贝到用户级 / 设为当前 / 设为默认或取消默认）
 *
 * @param deps 视图依赖
 * @param actions 卡片动作区容器
 * @param pack 卡片对应的角色包
 */
export function appendRoleCardActions(
  deps: RoleCardControlDeps,
  actions: HTMLElement,
  pack: RoleCardPack,
): void {
  const { document, post } = deps;
  // 「带入对话」：切换角色并跳到对话视图（预填过渡语，不自动发送）
  const handoffBtn = document.createElement('button');
  handoffBtn.className = 'btn btn-primary';
  handoffBtn.textContent = '带入对话';
  handoffBtn.title = '切换角色并跳到对话视图：已在输入框预填一句过渡语（不自动发送，可编辑后再发）';
  handoffBtn.addEventListener('click', () => post({ type: 'roles_handoff', name: pack.name }));
  actions.appendChild(handoffBtn);
  // 项目级专属：拷贝到用户级（非同步；同名先备份再覆盖）
  if (pack.source === 'project') appendPromoteToUserButton(actions, 'rolePack', pack.name, post);

  // 「设为当前」：仅非激活角色展示（切的是**当前会话**的角色）
  if (pack.name !== deps.activeName) {
    const actBtn = document.createElement('button');
    actBtn.className = 'btn btn-secondary';
    actBtn.textContent = '设为当前';
    actBtn.title = '切换当前会话的角色，停留在设置页（不跳转到对话）';
    actBtn.addEventListener('click', () => post({ type: 'roles_set_active', name: pack.name }));
    actions.appendChild(actBtn);
  }
  // 「设为默认 / 取消默认」：只写用户级配置，影响**此后新建**会话；不切当前会话、不改已有会话
  if (pack.name === deps.defaultName) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-secondary';
    clearBtn.textContent = '取消默认';
    clearBtn.title = '取消后新建会话使用系统兜底角色；不影响当前与已有会话';
    clearBtn.addEventListener('click', () =>
      post({ type: 'roles_set_active', name: '', scope: 'default' }),
    );
    actions.appendChild(clearBtn);
  } else {
    const defBtn = document.createElement('button');
    defBtn.className = 'btn btn-secondary';
    defBtn.textContent = '设为默认';
    defBtn.title = '此后新建会话自动使用该角色；不改变当前会话与已有会话';
    defBtn.addEventListener('click', () =>
      post({ type: 'roles_set_active', name: pack.name, scope: 'default' }),
    );
    actions.appendChild(defBtn);
  }
}
