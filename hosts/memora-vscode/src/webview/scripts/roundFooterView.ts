/**
 * 问答闭环容器底栏（ACTIONS-SSOT-1）
 *
 * 底栏 = 复制整链 + 轮级动作（真源 `components/roundActions`）+ 时间戳。
 * 判据与执行全部在真源；本文件只做三件**呈现差异段**：
 *   ① 图标按钮形态（DOM 契约：.msg-copy-icon / .msg-regenerate-icon / .msg-fork-icon /
 *      .msg-delete-icon，顺序 = 复制 → 重新生成 → 分叉 → 删除）；
 *   ② 从 DOM 读取轮级锚点（`roundActionCtx` 单点：构建 / 点击 / 锁刷新三处共用）；
 *   ③ 整链文本提取（`roundChainText`，底栏专属——菜单不做「复制整链」）。
 *
 * 为什么外置：chatView 逼近 max-lines 闸（阈值与取数口径同源见 `eslint.config.mjs`），
 * 本模块接管底栏后 chatView 净减行；同时「段级 .msg-footer」已退役（容器底栏是唯一可见
 * 操作面，旧段级 footer 恒被 CSS 隐藏），留着就是第三份动作面（不带伤原则：接管即退役）。
 */
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import { copyText } from '../helpers/selectionClipboard.js';
import { fmtTime } from '../helpers/fmtTime.js';
import { ROUND_ACTIONS, findRoundAction, type RoundActionCtx } from '../components/roundActions.js';
import { createIcon } from './icons.js';

/** 底栏图标按钮类名（DOM / 测试契约；呈现映射归本面，真源表不掺 UI 类名） */
const BTN_CLASS: Record<(typeof ROUND_ACTIONS)[number]['id'], string> = {
  regenerate: 'msg-regenerate-icon',
  fork: 'msg-fork-icon',
  'delete-turn': 'msg-delete-icon',
};

/**
 * 从容器解析轮级动作锚点（**单一读取点**）。
 *
 * 为什么读 DOM 而不缓存：`commitTurnTs` / `commitRoundId` 都在建栏之后回填
 * （运行中 roundId 只写 `.msg`、不回填容器），缓存快照必然过期。
 *
 * @param group 容器元素（可为 null：按钮尚未入树时的兜底）
 * @returns 空锚（不可用）或本轮真实锚点
 */
function roundActionCtx(group: HTMLElement | null): RoundActionCtx {
  if (!group) return { turnTs: '', roundId: '' };
  const firstSeg = group.querySelector<HTMLElement>('.msg.assistant');
  return {
    // 截断锚 = 本轮首个 assistant 段 ts（user 起点 / 重放 assistant ts 均可命中同一 Round）
    turnTs: firstSeg?.dataset.ts ?? '',
    // 分叉锚优先容器自身；运行中容器可能仍是空串 ⇒ 回退首段（commitRoundId 的回填位置）
    roundId: group.dataset.roundId || firstSeg?.dataset.roundId || '',
  };
}

/**
 * 整条问答的复制文本：用户提问 + 本轮全部 assistant 原始 Markdown。
 *
 * 用户提问取容器前一个兄弟（`.msg-wrapper`，其 textContent 即提问正文）；
 * assistant 段取 dataset.rawText（流式定稿后已是完整原文，不是渲染后的可见文本）。
 *
 * @param group 容器元素
 * @returns 以空行分隔的整链文本
 */
function roundChainText(group: HTMLElement): string {
  const parts: string[] = [];
  const user = group.previousElementSibling;
  if (user instanceof HTMLElement && user.classList.contains('msg-wrapper')) {
    const text = user.textContent?.trim();
    if (text) parts.push(text);
  }
  group.querySelectorAll<HTMLElement>('.msg.assistant').forEach((seg) => {
    const text = (seg.dataset.rawText ?? '').trim();
    if (text) parts.push(text);
  });
  return parts.join('\n\n');
}

/** 底栏构建参数 */
export interface RoundFooterOptions {
  /** 容器元素（footer 挂在其底部） */
  group: HTMLElement;
  /** 内容是否未定稿（流式 true → is-pending 隐藏；回放 / 一次性 false） */
  pending: boolean;
  /** 会话结构锁（建栏瞬间的锁态，决定轮级按钮初始 disabled） */
  locked: boolean;
  /** 发消息（chatView 注入 vscode.postMessage） */
  post: (msg: WebviewToExtensionMessage) => void;
}

/**
 * 构建容器底栏（幂等：已有 footer 直接返回）。
 *
 * @param opts 见 {@link RoundFooterOptions}
 */
export function buildRoundGroupFooter(opts: RoundFooterOptions): void {
  const { group, pending, locked, post } = opts;
  // 幂等：同容器重复建栏会叠出两份操作行
  if (group.querySelector('.round-group__footer')) return;
  const footer = document.createElement('div');
  footer.className = 'round-group__footer';
  if (pending) footer.classList.add('is-pending');
  const actions = document.createElement('div');
  actions.className = 'round-group__actions';
  // 复制整链：底栏专属动作（菜单没有「复制整链」），故不入轮级真源表，避免两处定义同一动作
  const copyBtn = createIcon('copy', '复制整条问答（含你的提问与全部回答）', 'msg-copy-icon');
  copyBtn.addEventListener('click', () => copyText(roundChainText(group)));
  actions.appendChild(copyBtn);
  // 轮级动作：文案 / 图标 / 判据 / 执行全部取自真源，本面只负责图标按钮形态
  const ctx = roundActionCtx(group);
  ROUND_ACTIONS.forEach((action) => {
    const btn = createIcon(action.icon, action.title, BTN_CLASS[action.id]);
    btn.dataset.roundAction = action.id;
    btn.disabled = !action.available(ctx, locked);
    btn.addEventListener('click', () => {
      // 点击时重读锚点（建栏后 commitTurnTs / commitRoundId 可能已回填）
      action.run(roundActionCtx(group), { post });
    });
    actions.appendChild(btn);
  });
  footer.appendChild(actions);
  // 时间戳：锚 = 本轮起点（首段 ts）；流式建栏时为空，由 settleRoundFooter 补写
  const time = fmtTime(ctx.turnTs);
  if (time) {
    const timeEl = document.createElement('span');
    timeEl.className = 'msg-time';
    timeEl.textContent = time;
    footer.appendChild(timeEl);
  }
  group.appendChild(footer);
}

/**
 * 终态显形（settle 单点）：移除 is-pending + 按当前锚补建缺失的时间戳。
 *
 * 运行时建栏时首段 `dataset.ts` 恒空 → 时间戳元素未创建；settle 前 commitTurnTs 已回填，
 * 本函数经同一个 `roundActionCtx` 读取点补建（不另写第二份「首段 ts」提取——旧实现
 * 在 chatView 里重新 `querySelector('.msg.assistant')` 属平行判据）。
 *
 * @param group 容器（无 footer 时什么也不做：诚实的「未建栏」由调用方自己决策）
 */
export function settleRoundGroupFooter(group: HTMLElement): void {
  const footer = group.querySelector<HTMLElement>('.round-group__footer');
  if (!footer) return;
  footer.classList.remove('is-pending');
  const time = fmtTime(roundActionCtx(group).turnTs);
  if (time && !footer.querySelector('.msg-time')) {
    const timeEl = document.createElement('span');
    timeEl.className = 'msg-time';
    timeEl.textContent = time;
    footer.appendChild(timeEl);
  }
}

/**
 * 按当前锁态刷新全部轮级动作按钮的 disabled（单一刷新入口）。
 *
 * 取代旧的「删除按钮 / 分叉按钮各扫一遍 + 各写一份锚点提取」双实现——
 * 现由真源 `available()` 统一裁决，锁刷新与菜单弹出时判据天然同源。
 *
 * @param root   扫描根（通常 document）
 * @param locked 当前会话结构锁
 */
export function refreshRoundActionButtons(root: ParentNode, locked: boolean): void {
  root.querySelectorAll<HTMLButtonElement>('[data-round-action]').forEach((btn) => {
    const action = findRoundAction(btn.dataset.roundAction ?? '');
    if (!action) return; // 未知 id 不猜语义：留旧态而非静默放开
    btn.disabled = !action.available(
      roundActionCtx(btn.closest<HTMLElement>('.round-group')),
      locked,
    );
  });
}
