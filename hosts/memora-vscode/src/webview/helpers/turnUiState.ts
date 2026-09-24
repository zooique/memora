/**
 * 骨架（会话控件）状态派生层 —— `SkeletonState` → UI 三态 → 按钮语义
 *
 * 设计源：docs/方案-turn运行时与会话渲染SSOT收口-20260923.md
 *
 * 职责边界：把 webview 侧散落的骨架自变量（会话三态 / 申请在途 / 输入内容）
 * **集中为一次纯函数派生**——本文件不读 DOM、不发消息、不碰内核，便于单测与变异验证。
 *
 * 真源：容器由 `turn_update.state`（完整 `TurnState`）直接赋值——`TurnState` 可赋值给
 * `SkeletonState`（投影子集，`Pick` 同族手法），派生链不依赖赋值来源。
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
 * `TurnState` → `SkeletonState` 投影（容器由此直接赋值）
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
 * 会话 UI 三态（骨架据此施加 DOM 按钮行为）
 *
 * - `thinking` —— 运行中：暂停按钮可用（申请在途时呈可反悔形态），发送按钮承担「停止」
 * - `paused`   —— 挂起（pause 与 ask 在三值态层同形）：发送按钮仍是硬停止；续跑键按
 *   `waiting.reason` 分叉（见 `deriveButtonSemantics`），并非一律「继续」
 * - `done`     —— 无进行中 turn：发送按钮恢复发送语义
 */
export type SessionUiState = 'thinking' | 'done' | 'paused';

/**
 * `SkeletonState` → 会话 UI 三态
 *
 * 🔴 **判据**：`waiting{pausePending:true}`（暂停申请在途）映射 **`thinking`**（不映射
 * `paused`）——用户申请了暂停但 step 边界未到，turn **仍在运行**：按钮只把「暂停」切成
 * 可反悔的「继续 ▶」，**发送按钮职责不变**（空输入仍是「停止生成」）。若误映射 `paused`，
 * 发送按钮文案会在申请在途窗口被改成挂起态文案（坑）。
 *
 * ask 也映射 `paused`：宿主对 ask 与 pause **同走** `pausedOnPurpose` 分支并同样发
 * `status:'paused'`（ask 走 `turn_update.state.waiting.ask` 渲染内联提问）。三值态只收
 * 「运行/挂起/收场」共性；ask 与 pause 的差异（续跑键职责）由 `deriveButtonSemantics`
 * 按 `waiting.reason` 分叉消费——内联提问块由 renderAskPhase 渲染，不属骨架矩阵。
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
  /** 骨架状态真源——须给完整 `SkeletonState`（含 `waiting.reason`）：续跑键职责随 reason
   *  分叉，先折成三值态再传入会把该区分抹掉（ask 死键曾因此被宣告） */
  state: SkeletonState;
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
  /** 暂停 / 继续按钮语义；null = 隐藏（`done` 态无职责；`waiting(ask)` 空输入无纯续跑能力，不宣告） */
  pause: { icon: 'pause' | 'play'; title: string; ariaLabel: string } | null;
  /** 发送按钮语义（`loading` = 呈现为停止方块） */
  send: { loading: boolean; title: string; ariaLabel: string; disabled: boolean };
}

/**
 * 按钮语义矩阵：`SkeletonState × hasInput` → 语义数据
 *
 * 与 `syncButtonSemantics` 的 DOM 施加行为逐分支等价（该函数委托本矩阵输出；文案、
 * `loading`、`disabled` 三者均对齐），等价性由 `webview/__tests__/chatView.test.ts` 的
 * 按钮矩阵用例锁定。
 *
 * 续跑键宣告纪律：**按钮只宣告路由真实收下的意图**——`resume` 路由只收 pause，故
 * `waiting(ask)` 空输入的「纯续跑」不渲染（不回答的兜底 = ask 超时自动续跑，产品定案
 * 无「跳过提问」按钮）；ask + 有输入的「发送补充并继续」是真能力（走 send 路由）。
 *
 * `disabled` 判据：**只有 `done` + 空输入**才禁用——运行中（thinking/paused）无论有无输入
 * 都可用（有输入 = interject 排队 / 带补充续跑，空输入 = 停止 / 继续）。
 */
export function deriveButtonSemantics(input: ButtonSemanticsInput): ButtonSemantics {
  const { state, hasInput } = input;
  const sessionUiState = deriveSessionUiState(state);
  const pausePending = derivePausePending(state);

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
    // 纯续跑（空输入点续跑）仅 waiting(pause) 为真能力——waiting(ask) 的 resume 会被
    // handleInput 静默丢弃 → ask + 空输入时续跑键整体隐藏（null，applyButtonSemantics 不写 title/aria）
    const plainResume = state.phase === 'waiting' && state.reason === 'pause';
    return {
      // 已挂起：pause 按钮承担「继续」（有输入 = 带补充续跑；空输入 = 纯续跑，仅 pause 相位）
      pause:
        hasInput || plainResume
          ? {
              icon: 'play',
              title: hasInput ? '发送补充并继续' : '继续生成',
              ariaLabel: hasInput ? '发送补充并继续' : '继续生成',
            }
          : null,
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
