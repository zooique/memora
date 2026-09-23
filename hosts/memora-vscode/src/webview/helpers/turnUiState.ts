/**
 * 骨架（会话控件）状态派生层 —— `SkeletonState` → UI 三态 → 按钮语义
 *
 * 设计源：docs/方案-turn运行时与会话渲染SSOT收口-20260923.md（M3b-2b-1 / 2b-2a）
 *
 * 职责边界：把 webview 侧散落的骨架自变量（会话三态 / 申请在途 / 输入内容）
 * **收敛为一次纯函数派生**——本文件不读 DOM、不发消息、不碰内核，便于单测与变异验证。
 *
 * 真源演化（本文件的定位随期推进，但不改动其判据）：
 * - **2b-2b / M5a**：容器改由 `turn_update.state`（完整 `TurnState`）直接赋值——`TurnState` 可
 *   赋值给 `SkeletonState`（投影子集，`Pick` 同族手法），故换源不动派生链；legacy 过渡适配器
 *   （`skeletonFromStatus` / `skeletonFromPausePending`）已随 M5a 删除（无生产消费，死代码）。
 */

// TurnState 纯类型导入（仅编译期用，esbuild 剥离，不影响 browser bundle）
import type { TurnState } from '../../shared/protocol.js';

/**
 * 骨架可见的 turn 状态（`TurnState` 的**投影子集**）
 *
 * 为什么不用完整 `TurnState`：骨架只需要「在跑 / 在等 / 已收场」+「等的是什么」
 * +「申请是否在途」，**不需要 `roundId` / `RoundStatus`**。要求完整 `TurnState` 会逼调用方
 * 造假的 `roundId` 去满足类型——那是往容器里塞假事实（比缺字段更危险）。
 *
 * 与 `TurnState` 的关系 = 结构兼容投影（同 `RoundView` 对 `Round` 的 `Pick<>` 手法）：
 * `TurnState` 的每个分支都能赋值给这里的对应分支，故换源时**直接赋值即可**；
 * 该投影兼容性由 `turnUiState.test.ts` 的「契约守卫」用例逐分支赋值锁定（编译期 + 运行期双查）。
 */
export type SkeletonState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'waiting'; reason: 'pause' | 'ask'; pausePending?: boolean }
  | { phase: 'settled' };

/**
 * `TurnState` → `SkeletonState` 投影（**M3b-2b-2b 换真源**：容器改由此直接赋值）
 *
 * 剥掉骨架用不到的 `roundId` / `RoundStatus` / `questions`——`TurnState.running.roundId`
 * 可选（宿主流起始投影时未知）也不影响投影：骨架输出根本不消费它。
 * 本函数是**转移函数**而非纯映射（`turn_update.state` 本身就是完整状态快照，无需结合前值推演）。
 */
export function skeletonFromTurnState(state: TurnState): SkeletonState {
  switch (state.phase) {
    case 'idle':
      return { phase: 'idle' };
    case 'running':
      return { phase: 'running' };
    case 'waiting':
      return { phase: 'waiting', reason: state.reason, pausePending: state.pausePending };
    case 'settled':
      return { phase: 'settled' };
  }
}

/**
 * 会话 UI 三态（与 legacy `_sessionUiState` 同域，保证 DOM 行为不变）
 *
 * - `thinking` —— 运行中：暂停按钮可用（申请在途时呈可反悔形态），发送按钮承担「停止」
 * - `paused`   —— 挂起（pause 与 ask **同形**）：暂停按钮换「继续」，发送按钮仍是硬停止
 * - `done`     —— 无进行中 turn：发送按钮恢复发送语义
 */
export type SessionUiState = 'thinking' | 'done' | 'paused';

/**
 * `SkeletonState` → 会话 UI 三态
 *
 * 🔴 **判据订正（2026-09-23，2b-2a 换源前实测发现）**：`waiting{pausePending:true}`
 * （暂停申请在途）映射 **`thinking`** 而非 `paused`——用户申请了暂停但 step 边界未到，
 * turn **仍在运行**：按钮只把「暂停」切成可反悔的「继续 ▶」，**发送按钮职责不变**
 * （空输入仍是「停止生成」，不是「停止生成（丢弃检查点）」）。若映射 `paused`，
 * 发送按钮文案会在申请在途窗口被改成挂起态文案 —— 那是行为变更，而非等价迁移。
 *
 * ask 也映射 `paused` 的依据是 legacy 实际行为：宿主对 ask 与 pause **同走** `pausedOnPurpose`
 * 分支并同样发 `status:'paused'`（ask 仅额外发 `need_clarify` 渲染内联提问）；二者在
 * `SkeletonState.waiting.reason` 上可区分，但**骨架输出不区分**（内联提问块由 `need_clarify`
 * 自身渲染，不属骨架矩阵）。
 */
export function deriveSessionUiState(state: SkeletonState): SessionUiState {
  switch (state.phase) {
    case 'running':
      return 'thinking';
    case 'waiting':
      return state.pausePending ? 'thinking' : 'paused';
    case 'settled':
    case 'idle':
      return 'done';
  }
}

/**
 * `SkeletonState` → 「暂停申请在途」布尔量
 *
 * 只有 `waiting{reason:'pause', pausePending:true}`（申请已入队、step 边界未到）为真：
 * 内核已挂起（`waiting` 无 `pausePending`）或运行中都不算申请在途。
 */
export function derivePausePending(state: SkeletonState): boolean {
  return state.phase === 'waiting' && state.pausePending === true;
}

/** 按钮语义派生入参（webview 侧骨架自变量的只读快照） */
export interface ButtonSemanticsInput {
  /** 会话 UI 三态（`deriveSessionUiState` 的输出） */
  sessionUiState: SessionUiState;
  /** 暂停申请在途（`derivePausePending` 的输出） */
  pausePending: boolean;
  /** 输入框是否有非空内容（决定发送按钮是「停止」还是「补充/发送」） */
  hasInput: boolean;
}

/**
 * 会话按钮语义（**数据**，不直接操作 DOM——施加由调用方完成）
 *
 * `pause: null` 表示该按钮在本态无职责（隐藏）；**null 时不得写 icon/title/aria**，
 * 否则会把隐藏按钮的属性改成与可见态不一致的值（无意义的状态污染）。
 */
export interface ButtonSemantics {
  /** 暂停 / 继续按钮语义；null = 隐藏（`done` 态该按钮无职责） */
  pause: { icon: 'pause' | 'play'; title: string; ariaLabel: string } | null;
  /** 发送按钮语义（`loading` = 呈现为停止方块） */
  send: { loading: boolean; title: string; ariaLabel: string; disabled: boolean };
}

/**
 * 按钮语义矩阵：`sessionUiState × pausePending × hasInput` → 语义数据
 *
 * 与 `syncButtonSemantics` 原实现逐分支等价（文案、`loading`、`disabled` 三者均对齐），
 * 等价性由 `webview/__tests__/chatView.test.ts` 的按钮矩阵用例锁定。
 *
 * `disabled` 判据：**只有 `done` + 空输入**才禁用——运行中（thinking/paused）无论有无输入
 * 都可用（有输入 = interject 排队 / 带补充续跑，空输入 = 停止 / 继续）。
 */
export function deriveButtonSemantics(input: ButtonSemanticsInput): ButtonSemantics {
  const { sessionUiState, pausePending, hasInput } = input;

  if (sessionUiState === 'thinking') {
    return {
      // 申请在途即切「继续 ▶」：用户心智 = 申请在了就是在暂停，可再点反悔（取消申请）
      pause: pausePending
        ? { icon: 'play', title: '继续（点击取消暂停申请）', ariaLabel: '继续（取消暂停申请）' }
        : { icon: 'pause', title: '暂停生成', ariaLabel: '暂停生成' },
      send: hasInput
        ? {
            loading: false,
            title: '发送补充（排队等 step 边界注入）',
            ariaLabel: '发送补充',
            disabled: false,
          }
        : { loading: true, title: '停止生成', ariaLabel: '停止生成', disabled: false },
    };
  }

  if (sessionUiState === 'paused') {
    return {
      // 已挂起：pause 按钮承担「继续」（有输入 = 带补充续跑，空输入 = 纯续跑）
      pause: {
        icon: 'play',
        title: hasInput ? '发送补充并继续' : '继续生成',
        ariaLabel: hasInput ? '发送补充并继续' : '继续生成',
      },
      // 发送按钮在挂起态始终承担「硬停止」（丢弃检查点）
      send: {
        loading: true,
        title: '停止生成（丢弃检查点）',
        ariaLabel: '停止生成',
        disabled: false,
      },
    };
  }

  return {
    pause: null,
    send: { loading: false, title: '发送 (Enter)', ariaLabel: '发送', disabled: !hasInput },
  };
}
