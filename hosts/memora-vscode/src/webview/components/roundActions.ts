/**
 * 轮级动作真源（ACTIONS-SSOT-1）
 *
 * 一份表定义「一个轮级动作是什么」：菜单文案 / 按钮提示 / 图标 / 可用判据 / 执行。
 * 两个消费面只写差异段：
 *   - 容器底栏（scripts/roundFooterView）→ 图标按钮，disabled = !available(ctx, locked)；
 *   - 右键菜单（components/contextMenuItems）→ 文字项，when = 场合命中 && available(ctx, locked)。
 *
 * 🔴 纪律：任何一面都不得再写第二份「锁 / 锚点」判断。加动作 = 只改本表；两面自动同频。
 * 反面教材（本表要消灭的形态）：底栏 disabled 与菜单 when 各写一份，漏改一面即「右键有、
 * 底栏没有」——2026-10-31 实锤。
 *
 * 锚点口径（由 roundFooterView.roundActionCtx 单点从 DOM 读取，不在此处推导）：
 *   - turnTs = 本轮起点 ts（容器内首个 assistant 段的 dataset.ts），删除 / 重新生成共用同一截断面；
 *   - roundId = 容器 dataset.roundId（运行中 commitRoundId 只回填到 .msg ⇒ 回退首段 dataset.roundId）。
 */
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import type { IconName } from '../scripts/icons.js';

/** 动作锚点：只装轮级事实；会话锁是全局状态，单独以参数传入（不是轮的属性） */
export interface RoundActionCtx {
  /** 本轮起点 ts：删除 / 重新生成的截断锚 */
  turnTs: string;
  /** 本轮 roundId：分叉锚 */
  roundId: string;
}

/** 动作执行依赖：两个消费面各自注入（轮级动作只需要「发消息」这一项能力） */
export interface RoundActionDeps {
  post(msg: WebviewToExtensionMessage): void;
}

/** 轮级动作定义：每个字段全库只有这一份 */
export interface RoundAction {
  /** 动作 id（右键菜单项 id / 底栏按钮 data-round-action 的同一取值） */
  id: 'regenerate' | 'fork' | 'delete-turn';
  /** 右键菜单文案 */
  label: string;
  /** 图标按钮 tooltip / aria-label */
  title: string;
  /** 图标（复用 icons.ts 既有图形，不新增 path） */
  icon: IconName;
  /** 危险操作（菜单红色高亮；底栏沿用同一按钮形态） */
  danger?: boolean;
  /**
   * 可用判据（单点，两面共用）
   *
   * @param ctx    轮级锚点（空锚 = 该动作在此轮不可用）
   * @param locked 会话结构锁（运行时禁用一切改变会话结构的操作）
   */
  available(ctx: RoundActionCtx, locked: boolean): boolean;
  /**
   * 执行：锚点取自 ctx。
   *
   * 不在此二次校验可用性——可用性由各面按 available() 表达（菜单隐藏 / 按钮置灰），
   * 避免「判了两遍、两遍不一致」的第二真理源。
   */
  run(ctx: RoundActionCtx, deps: RoundActionDeps): void;
}

/** 轮级动作全集（顺序 = 底栏图标顺序；菜单也按此顺序派生，两面不会漂） */
export const ROUND_ACTIONS: readonly RoundAction[] = [
  {
    id: 'regenerate',
    label: '重新生成',
    title: '重新生成该问答（删除本轮及之后对话，并以原文重发）',
    icon: 'refresh',
    // 与删除同强度：截断会话结构，锁态下不可用
    available: (ctx, locked) => !locked && !!ctx.turnTs,
    run: (ctx, deps) => deps.post({ type: 'input', kind: 'regenerate', turnTs: ctx.turnTs }),
  },
  {
    id: 'fork',
    label: '分叉',
    title: '从此问答闭环分叉新会话',
    icon: 'fork',
    available: (ctx, locked) => !locked && !!ctx.roundId,
    run: (ctx, deps) => deps.post({ type: 'fork_session', roundId: ctx.roundId }),
  },
  {
    id: 'delete-turn',
    label: '删除',
    danger: true,
    title: '删除该问答及之后所有对话',
    icon: 'delete',
    available: (ctx, locked) => !locked && !!ctx.turnTs,
    run: (ctx, deps) => deps.post({ type: 'delete_turn', ts: ctx.turnTs }),
  },
];

/** 按 id 反查动作（底栏锁态刷新按按钮 data-round-action 定位用） */
export function findRoundAction(id: string): RoundAction | undefined {
  return ROUND_ACTIONS.find((action) => action.id === id);
}
