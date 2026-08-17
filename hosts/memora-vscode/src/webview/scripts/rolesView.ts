/**
 * rolesView — 角色管理面板 webview 运行时脚本（阶段 B P2-1 模式，2026-08-17）
 *
 * 由 rolePackPanel.ts 的 buildHtml 引用：以工厂函数 createRolesView 接收依赖
 * （acquireVsCodeApi / window）并初始化全部交互，替代「字符串注入脚本」。
 *
 * 职责：
 *   - 渲染角色包卡片列表（激活徽章 + 定位描述 + 能力标签 chips）；
 *   - 「设为当前」→ postMessage roles_set_active（host 切换 + 持久化 + 重推）；
 *   - 监听 roles_loaded 渲染（host resolve 时推送 + 切换后重推）。
 *
 * 由 esbuild 以 browser/iife 打包为 dist/webview/scripts/rolesView.js，经
 * webview.asWebviewUri 在 HTML 中 <script src> 引用（CSP script-src cspSource）。
 */
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { createEmptyState, createGroupTitle } from '../helpers/cardList.js';

/** rolesView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface RolesViewDeps {
  /** 获取 webview 通信 API（仅 webview 上下文合法） */
  acquireVsCodeApi: () => { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
}

/** 角色列表加载完成载荷（roles_loaded）的最小结构 */
interface RolesPayload {
  packs: {
    name: string;
    displayName: string;
    description?: string;
    capabilities: { capability: string; label: string }[];
  }[];
  activeName: string;
}

/**
 * 初始化角色管理面板 webview 交互
 *
 * @param deps 运行时依赖（acquireVsCodeApi + window）
 */
export function createRolesView({ acquireVsCodeApi, window }: RolesViewDeps): void {
  const document = window.document;
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list') as HTMLElement;
  const statBar = document.getElementById('statBar') as HTMLElement;

  let activeName: string | undefined;

  /** 渲染角色包列表：激活角色置顶高亮，其余按序展示（对齐 config 面板分组） */
  function render(data: RolesPayload): void {
    statBar.hidden = false;
    statBar.textContent = `已加载 ${data.packs?.length ?? 0} 个角色`;
    if (!data.packs || data.packs.length === 0) {
      // 空态引导：无角色包时提示（SSOT：createEmptyState 纯函数，对齐 configView 列表级同构）
      list.textContent = '';
      list.appendChild(
        createEmptyState(document, {
          title: '暂无角色包',
          hint: '请先打开一个工作区，或安装角色包后重新加载',
        }),
      );
      return;
    }
    activeName = data.activeName;
    list.textContent = '';
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

  /** 构建单个角色包卡片（名称 + 徽章 + 描述 + 能力标签 + 设为当前） */
  function buildCard(p: RolesPayload['packs'][number]): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card' + (p.name === activeName ? ' active' : '');

    // 卡片图标：角色显示名首字（提升扫读，对齐 config 面板 §6.2）
    const icon = document.createElement('div');
    icon.className = 'role-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = p.displayName.charAt(0);

    const info = document.createElement('div');
    info.className = 'card-info';
    const nameRow = document.createElement('div');
    nameRow.className = 'card-name';
    nameRow.textContent = p.displayName;
    if (p.name === activeName) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '当前';
      nameRow.appendChild(badge);
    }
    info.appendChild(nameRow);

    // 定位描述（manifest.description，可选）
    if (p.description) {
      const desc = document.createElement('div');
      desc.className = 'card-detail';
      desc.textContent = p.description;
      info.appendChild(desc);
    }

    // 能力标签 chips：角色能做什么（能力名 → 中文 label，host 已翻译）
    if (p.capabilities && p.capabilities.length > 0) {
      const caps = document.createElement('div');
      caps.className = 'cap-chips';
      p.capabilities.forEach((c) => {
        const chip = document.createElement('span');
        chip.className = 'cap-chip';
        chip.textContent = c.label;
        chip.title = c.capability; // hover 显示原始能力名（域:动作）
        caps.appendChild(chip);
      });
      info.appendChild(caps);
    }
    card.appendChild(icon);
    card.appendChild(info);

    // 「设为当前」：仅非激活角色展示（对齐 config 面板「设为当前」交互）
    if (p.name !== activeName) {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      const actBtn = document.createElement('button');
      actBtn.className = 'btn btn-secondary';
      actBtn.textContent = '设为当前';
      actBtn.addEventListener('click', () =>
        vscode.postMessage({ type: 'roles_set_active', name: p.name }),
      );
      actions.appendChild(actBtn);
      card.appendChild(actions);
    }
    return card;
  }

  // 消息接收：roles_loaded 渲染列表
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'roles_loaded') render(msg);
  });
}
