/**
 * 骨架（会话控件）状态派生层 —— `TurnState` → UI 三态 → 按钮语义
 *
 * 设计源：docs/方案-turn运行时与会话渲染SSOT收口-20260923.md（M3b-2b-1）
 *
 * 职责边界：把 webview 侧散落的骨架自变量（`_sessionUiState` / `_pausePending` / 输入内容）
 * **收敛为一次纯函数派生**——本文件不读 DOM、不发消息、不碰内核，便于单测与变异验证。
 *
 * 为什么需要它：骨架状态的写入点此前散落在 4 处（`setStatus` 写 `_sessionUiState`、
 * `pause_pending` 分支写 `_pausePending`、输入事件与程序化回填各写一次按钮类），
 * 而 `TurnState` 已经同时携带「是否运行 / 是否挂起 / 申请是否在途」三件事 ⇒ 两个布尔碎片
 * 都只是 `TurnState` 的函数。派生层建立后，M3b-2b-2 才能把真源从「四条消息各写一角」
 * 换成「单一 `turnState` → 派生 → 施加」。
 *
 * ⚠ 时序差异（M3b-2b-2 换真源前须拍板，勿当零变更）：legacy `status:'done'` 由宿主
 * **延后**发送（等 round-summary 完成或 5s 兜底），而 `TurnState.phase==='settled'` 是流尾
 * **即时**的 ⇒ `settled` 直接映射 `'done'` 会让发送按钮恢复时机提前到流尾。
 * 本文件只表达语义映射，不决定接线时机。
 */

import type { TurnState } from '../../shared/protocol.js';

/**
 * 会话 UI 三态（与既有 `_sessionUiState` 同域，保持 DOM 行为不变）
 *
 * - `thinking` —— 运行中：暂停按钮可用，发送按钮承担「停止」
 * - `paused`   —— 挂起（pause 与 ask **同形**）：暂停按钮换「继续」，发送按钮仍是硬停止
 * - `done`     —— 无进行中 turn：发送按钮恢复发送语义
 */
export type SessionUiState = 'thinking' | 'done' | 'paused';

/**
 * `TurnState` → 会话 UI 三态
 *
 * 映射依据 = legacy 通道的实际行为（不是凭设计意图）：
 * - `waiting{reason:'ask'}` 也映射 `'paused'` —— 宿主对 ask 与 pause **同走** `pausedOnPurpose`
 *   分支并同样 `post({type:'status', state:'paused'})`（ask 另额外发 `need_clarify` 渲染内联提问）。
 * - `settled` / `idle` 均映射 `'done'` —— 二者都表示「无进行中 turn，可发送新提问」。
 */
export function deriveSessionUiState(state: TurnState): SessionUiState {
  switch (state.phase) {
    case 'running':
      return 'thinking';
    case 'waiting':
      return 'paused';
    case 'settled':
    case 'idle':
      return 'done';
  }
}

/**
 * `TurnState` → 「暂停申请在途」布尔量
 *
 * 只有 `waiting{reason:'pause', pausePending:true}`（申请已入队、step 边界未到）为真：
 * 内核已挂起（`waiting` 无 `pausePending`）或运行中都不算申请在途。
 */
export function derivePausePending(state: TurnState): boolean {
  return state.phase === 'waiting' && state.pausePending === true;
}

/** 按钮语义派生入参（webview 侧现有自变量的只读快照） */
export interface ButtonSemanticsInput {
  /** 会话 UI 三态（`deriveSessionUiState` 的输出，或 legacy 通道写入的同域值） */
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
