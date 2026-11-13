/**
 * 角色卡「创建 / 编辑队伍」弹窗（自 `rolesView.ts` 外置）
 *
 * 外置理由：`rolesView.ts` 逼近 max-lines `只降不升` 基线（本地化后 l10n 调用换行曾把文件顶过 1000 行，现回落到 927），
 * 弹窗是自足的一块 DOM 构造逻辑（输入 = 角色包 + 队伍名单 + 上限，输出 = 一条 `roles_team_save`
 * 或 `roles_team_delete` 消息），与视图其余部分零共享状态，是最干净的抽取边界。
 *
 * 边界：**不持有状态、不缓存节点**——每次调用现建现挂，关闭即 `remove()`。
 *
 * 语义要点（原注释保留）：
 *   - 电话本式勾选除当前队长外的所有角色，组员上限由宿主下发（内核常量 SSOT，本地禁止写死）；
 *   - 编辑既有队伍时回显已选组员；复用 `roles_team_save` 保存契约；
 *   - 默认保留「当前角色已是别队成员」的共享说明（内核当前无互斥限制，组员可复用）。
 *
 * @module rolesTeamModal
 */

import * as l10n from '@vscode/l10n';
import { getIconSvg } from './icons.js';
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';

/** 弹窗需要的角色包最小面（结构兼容 `roles_loaded.packs` 元素） */
export interface TeamModalPack {
  /** 包名（消息寻址用） */
  name: string;
  /** 展示名 */
  displayName: string;
  /** 兜底契约包标记（勾选行追加「（兜底）」后缀） */
  isFallback?: boolean;
}

/** 弹窗需要的载荷最小面（结构兼容 `roles_loaded`） */
export interface TeamModalData {
  /** 全部角色包（除当前队长外都进候选） */
  packs: readonly TeamModalPack[];
  /** 既有队伍名单（编辑态回显 + 共享说明） */
  teams?: readonly { leader: string; members: readonly string[] }[];
  /** 组员数量上限（内核常量经宿主下发） */
  maxTeamMembers: number;
}

/** 弹窗依赖（document / root / 通信面由调用方注入，模块内不读全局） */
export interface TeamModalDeps {
  /** webview 文档对象 */
  document: Document;
  /** 子视图挂载根容器（挂载点隔离：不用全局 getElementById） */
  root: HTMLElement;
  /** 通信面（发 roles_team_save / roles_team_delete） */
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  /** 本次操作的队长角色包 */
  pack: TeamModalPack;
  /** 当前角色列表载荷（候选 + 既有队伍 + 上限） */
  data: TeamModalData;
}

/**
 * 打开「创建 / 编辑队伍」弹窗（详情见模块头注释）。
 *
 * @param deps 注入依赖（见 {@link TeamModalDeps}）
 */
export function launchTeamModal({ document, root, vscode, pack: p, data }: TeamModalDeps): void {
  const overlay = document.createElement('div');
  overlay.className = 'team-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'team-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', l10n.t('Create a team led by "{0}"', p.displayName));

  const head = document.createElement('div');
  head.className = 'team-modal-head';
  const title = document.createElement('span');
  title.className = 'team-modal-title';
  title.textContent = l10n.t('Create team · leader {0}', p.displayName);
  const close = document.createElement('button');
  close.className = 'btn team-modal-close';
  close.innerHTML = getIconSvg('close', 12, 12);
  close.title = l10n.t('Close');
  close.addEventListener('click', () => overlay.remove());
  head.appendChild(title);
  head.appendChild(close);
  modal.appendChild(head);

  const current = data.teams?.find((t) => t.leader === p.name);
  const selected = new Set(current?.members ?? []);
  // 组员上限：内核常量 MAX_TEAM_MEMBERS 经宿主从 roles_loaded 下发（SSOT 单一来源，禁止本地字面量）
  const LIMIT = data.maxTeamMembers;

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
    txt.textContent = x.isFallback ? l10n.t('{0} (fallback)', x.displayName) : x.displayName;
    item.appendChild(cb);
    item.appendChild(txt);
    // 已达组员上限时禁止继续勾选；取消勾选始终允许
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

  // 反馈区：组员上限提示（默认）+ 当前角色已是别队成员时的共享说明
  const hint = document.createElement('div');
  hint.className = 'team-modal-hint';
  const sharedLeader = data.teams?.find((t) => t.leader !== p.name && t.members.includes(p.name));
  hint.textContent = !sharedLeader
    ? l10n.t(
        'Team limit {0}: 1 leader + up to {1} members (checking more than {1} is rejected automatically)',
        LIMIT + 1,
        LIMIT,
      )
    : l10n.t(
        'This role already joins the team of "{0}"; creating its own team keeps that participation.',
        sharedLeader.leader,
      );
  modal.appendChild(hint);

  const actions = document.createElement('div');
  actions.className = 'team-modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn btn-secondary';
  cancel.textContent = l10n.t('Cancel');
  cancel.addEventListener('click', () => overlay.remove());
  const save = document.createElement('button');
  save.className = 'btn btn-primary';
  save.textContent = current ? l10n.t('Save team') : l10n.t('Create team');
  save.addEventListener('click', () => {
    const members = Array.from(list.querySelectorAll('input:checked')).map(
      (el) => (el as HTMLInputElement).value,
    );
    vscode.postMessage({ type: 'roles_team_save', leader: p.name, members });
    overlay.remove();
  });
  actions.appendChild(cancel);
  actions.appendChild(save);
  // 编辑态删除队伍：仅当已有队伍时提供（解散队伍 = 移除会议名单，不影响角色日常）
  if (current) {
    const del = document.createElement('button');
    del.className = 'btn btn-danger team-modal-del';
    del.textContent = l10n.t('Delete team');
    del.title = l10n.t(
      'Dissolve this team (removes the meeting roster; no effect on regular role use)',
    );
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
  // 挂载到注入 root（id 空间隔离约定：不用 document.getElementById 全局查找，
  // 与 createRolesView 收受依赖的 root 一致——测试/多实例下 root 可能非 #roles-root）
  root.appendChild(overlay);
}
