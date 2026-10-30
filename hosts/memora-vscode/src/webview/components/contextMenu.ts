/**
 * 右键语义菜单组件（COPY-2 · Layer B）——自绘 HTML 菜单，不接管文本级剪贴板
 *
 * 设计（吸收 Cline / Roo Code / Copilot Chat / Claude Code 的共性形态）：
 *  - **语义操作自建，文本剪贴板不碰**：输入框 / 文本域 / contenteditable 上的
 *    contextmenu 不拦截，原生剪切/复制/粘贴与图片粘贴路径原样放行（放行守卫单点在本组件）。
 *  - **场合命中判据单点**：resolveContextMenuCtx 一处判定 selection / code / message
 *    三场合（优先级 selection > code > message——有选区优先，代码块深于消息条），菜单项按
 *    ctx 过滤。加菜单项 = 调用方表里加一行，不动命中逻辑（判据②：when 判据单点无第二份分支）。
 *  - **键盘导航复用 dropdown.ts 的 bindMenuKeyboardNav**（共享单点）：开合模型不同
 *    （触发器 click vs contextmenu 定位）不构成复制导航逻辑的理由。
 *  - **不用 contributes.menus 的 webview/context**：控不了按选区动态显隐，跨版本不稳；
 *    自建 HTML 菜单为主流形态（台账 COPY-2 平台边界定案）。
 *  - 样式：contextMenuStyles 不内嵌 tokens，由挂载面板统一注入（同 dropdownStyles 令牌前提；
 *    挂载点 = chatPanel styles 拼接处）。
 */
import { bindMenuKeyboardNav } from './dropdown.js';

/** 右键场合解析产物：字段允许为空（如部分消息条无 roundId），调用方 when/run 自判空 */
export interface ContextMenuCtx {
  /** selection = 命中非空选区；code = 命中代码块；message = 命中消息条其余部分 */
  kind: 'selection' | 'code' | 'message';
  /** 命中的消息条元素（.msg）；selection/code 场合也可能同时命中所在消息条 */
  messageEl: HTMLElement | null;
  /** 代码块纯文本（kind=code 时非空） */
  codeText: string;
  /** 选区纯文本（kind=selection 时非空） */
  selectionText: string;
  /** 消息条锚点：markdown 原文（dataset.rawText） */
  rawText: string;
  /** 消息条锚点：渲染后纯文本（body.textContent） */
  visibleText: string;
  /** 轮锚点（dataset.roundId，分叉用；取不到 = 空串，调用方按空禁用） */
  roundId: string;
  /** 轮锚点（dataset.ts，删除/重新生成用；取不到 = 空串，调用方按空禁用） */
  turnTs: string;
}

export interface ContextMenuItem {
  /** 事件标识：调用方在 run 闭包内自分发（组件不解释 id） */
  id: string;
  label: string;
  /** 危险操作（红色高亮，形态同 DropdownItem.danger） */
  danger?: boolean;
  /** 显示判据：按 ctx 过滤（每项一处定义，不散落） */
  when(ctx: ContextMenuCtx): boolean;
  /** 执行：组件先关菜单再回调 */
  run(ctx: ContextMenuCtx): void;
}

/** 输入落点放行守卫：这些元素上的 contextmenu 走原生（文本剪贴板 + 图片粘贴不接管） */
function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return !!el.closest('textarea, input, [contenteditable]');
}

/**
 * 场合命中判据（**单点**）：优先级 selection > code > message。
 * 仅认 `.msg` 消息条与 `pre code` 代码块两个锚（与现有 hover 复制按钮的宿主范围一致），
 * 其余区域（空白 / 设置页元素）返回 null = 不弹菜单、不拦截原生行为。
 */
export function resolveContextMenuCtx(target: EventTarget | null): ContextMenuCtx | null {
  const el = target instanceof Element ? target : null;
  if (!el) return null;
  const selectionText = (target instanceof Document ? target.getSelection() : window.getSelection())
    ?.toString()
    .trim();
  const codeEl = el.closest('pre code');
  const messageEl = el.closest<HTMLElement>('.msg');
  if (!messageEl) return null;
  const body = messageEl.querySelector<HTMLElement>('.msg-body');
  return {
    kind: selectionText ? 'selection' : codeEl ? 'code' : 'message',
    messageEl,
    codeText: codeEl?.textContent ?? '',
    selectionText: selectionText ?? '',
    rawText: messageEl.dataset.rawText ?? '',
    visibleText: body?.textContent ?? '',
    roundId: messageEl.dataset.roundId ?? '',
    turnTs: messageEl.dataset.ts ?? '',
  };
}

/**
 * 初始化右键语义菜单：document 级 contextmenu 委托 + 菜单渲染 + 键盘/点外关闭。
 * DOM 副作用仅在调用时执行（extension 端 import 安全）。
 *
 * 返回 dispose：卸载 document 级两监听并关闭在显菜单——组件监听挂在 root（document）
 * 上而非消息 DOM 上，宿主 dispose 链必须接住（漏接 = 面板重挂后监听叠加、一次右键多菜单）。
 *
 * @param root webview 文档对象
 * @param items 菜单项全集（按 ctx.when 过滤后渲染；过滤后为空 = 不拦截原生右键）
 */
export function initContextMenu(root: Document, items: ContextMenuItem[]): { dispose(): void } {
  let menu: HTMLDivElement | null = null;
  let activeCtx: ContextMenuCtx | null = null;

  const close = (): void => {
    menu?.remove();
    menu = null;
    activeCtx = null;
  };

  // 点击任意处关闭（菜单项自身的 click 在委托里 stopPropagation，不落到这里）
  const onDocClick = (): void => close();

  const onContextMenu = (e: MouseEvent) => {
    // 文本落点放行：输入框 / 文本域的右键 = 原生剪贴板菜单（COPY-2 平台边界）
    if (isTextEntryTarget(e.target)) {
      close();
      return;
    }
    const ctx = resolveContextMenuCtx(e.target);
    if (!ctx) {
      close();
      return;
    }
    const visible = items.filter((it) => it.when(ctx));
    if (visible.length === 0) return; // 无可显项 = 放行原生
    e.preventDefault();
    close();
    activeCtx = ctx;
    menu = root.createElement('div');
    menu.className = 'ctxmenu';
    menu.setAttribute('role', 'menu');
    for (const it of visible) {
      const btn = root.createElement('button');
      btn.type = 'button';
      btn.className = `ctxmenu__item${it.danger ? ' is-danger' : ''}`;
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('data-ctxmenu-id', it.id);
      btn.textContent = it.label;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const runCtx = activeCtx;
        close();
        if (runCtx) it.run(runCtx);
      });
      menu.appendChild(btn);
    }
    root.body.appendChild(menu);
    // 视口边界翻转：右溢出改左开、下溢出改上开（与 dropdown applyDropDirection 同思想，
    // 但 contextMenu 无触发器，按光标坐标直接测）
    const rect = menu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > root.documentElement.clientWidth - 8) {
      x = root.documentElement.clientWidth - rect.width - 8;
    }
    if (y + rect.height > root.documentElement.clientHeight - 8) {
      y = root.documentElement.clientHeight - rect.height - 8;
    }
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
    // 键盘导航共享单点：导航语义与 dropdown 同源；无触发器，Escape 后焦点归还消息条
    const anchor = ctx.messageEl;
    bindMenuKeyboardNav(root, menu, {
      getItems: () => Array.from(menu?.querySelectorAll<HTMLElement>('.ctxmenu__item') ?? []),
      close,
      onEscape: () => anchor?.focus(),
    });
    (menu.querySelector<HTMLElement>('.ctxmenu__item') ?? anchor)?.focus();
  };

  root.addEventListener('click', onDocClick);
  root.addEventListener('contextmenu', onContextMenu);
  return {
    dispose(): void {
      root.removeEventListener('click', onDocClick);
      root.removeEventListener('contextmenu', onContextMenu);
      close();
    },
  };
}
