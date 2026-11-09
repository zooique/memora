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
 *   - roundId = 轮身份 = **全部轮级动作的唯一锚点**（容器 dataset.roundId，运行中容器可能
 *     仍是空串 ⇒ 回退首段 dataset.roundId）；
 *   - startedAt = 本轮起点 ts，**仅供底栏时间戳显示**，禁止作为删除 / 重发锚点：ts 是 Round
 *     的投影而非身份，中断轮无 assistant ts 可锚，用它反推轮次只能靠时间窗猜测
 *     （历史事故 DELETE-ANCHOR-1：相邻两中断轮点了删除却删掉后面那轮）。
 */
import * as l10n from '@vscode/l10n';

import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import type { IconName } from '../scripts/icons.js';

/** 动作锚点：只装轮级事实；会话锁是全局状态，单独以参数传入（不是轮的属性） */
export interface RoundActionCtx {
  /** 轮身份：删除 / 重新生成 / 分叉共用的唯一锚点（空 = 该动作在此轮不可用） */
  roundId: string;
  /** 本轮起点 ts：**仅显示**（底栏时间戳），不得作锚点传入任何动作载荷 */
  startedAt: string;
}

/** 动作执行依赖：两个消费面各自注入（轮级动作只需要「发消息」这一项能力） */
export interface RoundActionDeps {
  post(msg: WebviewToExtensionMessage): void;
}

/** 轮级动作定义：每个字段全库只有这一份 */
export interface RoundAction {
  /** 动作 id（右键菜单项 id / 底栏按钮 data-round-action 的同一取值） */
  id: 'regenerate' | 'fork' | 'delete-turn';
  /** 右键菜单文案（**函数形态**：本表在 `initWebviewL10n` 前即求值，存字符串会把语言写死） */
  label(): string;
  /** 图标按钮 tooltip / aria-label（同 `label`，调用时才解析译文） */
  title(): string;
  /** 图标（复用 icons.ts 既有图形，不新增 path） */
  icon: IconName;
  /** 危险操作（菜单红色高亮；底栏沿用同一按钮形态） */
  danger?: boolean;
  /**
   * 可用判据（单点，两面共用）
   *
   * @param ctx    轮级锚点（空锚 = 该动作在此轮不可用）
   * @param locked 会话结构写窗口锁（截断 / 分叉会重写会话文件，窗口内禁用；导航类不在其内）
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

/**
 * 轮级动作全集（顺序 = 底栏图标顺序；菜单也按此顺序派生，两面不会漂）
 *
 * 文案是**方法**而非字段：模块加载早于语言包就绪（`initWebviewL10n`），若写成字符串，
 * 表内 `l10n.t()` 会在无译文状态下求值，中文用户永远看到英文。
 */
export const ROUND_ACTIONS: readonly RoundAction[] = [
  {
    id: 'regenerate',
    label: () => l10n.t('Regenerate'),
    title: () =>
      l10n.t(
        'Regenerate this turn (deletes this turn and all later turns, then resends the original text)',
      ),
    icon: 'refresh',
    // 与删除同强度：截断会话结构，锁态下不可用
    available: (ctx, locked) => !locked && !!ctx.roundId,
    run: (ctx, deps) => deps.post({ type: 'input', kind: 'regenerate', roundId: ctx.roundId }),
  },
  {
    id: 'fork',
    label: () => l10n.t('Fork'),
    title: () => l10n.t('Fork a new session from this turn'),
    icon: 'fork',
    available: (ctx, locked) => !locked && !!ctx.roundId,
    run: (ctx, deps) => deps.post({ type: 'fork_session', roundId: ctx.roundId }),
  },
  {
    id: 'delete-turn',
    label: () => l10n.t('Delete'),
    danger: true,
    title: () => l10n.t('Delete this turn and all later turns'),
    icon: 'delete',
    available: (ctx, locked) => !locked && !!ctx.roundId,
    run: (ctx, deps) => deps.post({ type: 'delete_turn', roundId: ctx.roundId }),
  },
];

/** 按 id 反查动作（底栏锁态刷新按按钮 data-round-action 定位用） */
export function findRoundAction(id: string): RoundAction | undefined {
  return ROUND_ACTIONS.find((action) => action.id === id);
}
