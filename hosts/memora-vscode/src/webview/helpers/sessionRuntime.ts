/**
 * 会话级流运行态表
 *
 * 面板原先用四份单份字段（`_streaming` / `_abortController` / `_currentFlow` / `_liveBuffer`）
 * 承载「本流运行到哪一步」，只够一个会话在跑。本表把四者收进**按 sessionId 命名空间**的
 * 一条记录：同一会话反复取恒为同一对象（引用相等），不同会话互不可见。
 *
 * 结构先按会话命名空间化；导航放开后，流状态各自跟随所属会话，流中可切换 / 新建，宿主不再设闸。
 *
 * 生命周期 = 懒建、随面板实例存活（会话数上界 = 本面板打开过、或做过删除 / 归档 / 恢复取态的会话数）。会话被删除时由
 * `delete()` 摘除记录（见会话删除路径）：不摘就是永久残留的僵尸记录。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProcessEvent } from '@zooique/memora';
import type { RoundView } from '../../shared/protocol.js';

/**
 * 本流 live 缓冲：consumeFlow 运行期间的过程事件/流式正文/当前轮归属（会话级）。
 *
 * 为什么要实例级：webview 重建（折叠展开重建 HTML）后的 ready 握手重放需要读取
 * 「本流尚未落盘的内容」（流式正文不落盘、过程事件仅 step 边界增量 checkpoint）——
 * 局部缓冲流结束即焚，重放通道够不着，表现为「切界面回来本流内容全空白」。
 * 生命周期 = consumeFlow 开始创建；正常/中断收场清除；软暂停（pausedOnPurpose）保留——
 * 半截正文只在缓冲里，清了会让暂停中重建丢内容；续跑新流覆盖或最终收场时退场；
 * 身份比对防误清新流缓冲。删除 / 重新生成轮成功后 `discardLiveBuffer` 会主动清空现场（`chatTurnStructureOps`
 * 删轮路径，先于重放）。会话归属随行（sessionId），重建重放时校验当前会话，
 * 防切走再切回旧会话时跨会话污染。
 */
export interface LiveFlowBuffer {
  /** 缓冲所属会话（创建时刻的 sessionId）：重放投影前校验，防跨会话混入 */
  sessionId: string;
  /** 过程事件按 turn 分桶（与落盘真相源同一份 Map；有归轮键时 emitEvent 同时写缓冲与投影，无归轮键只即时投影） */
  eventsByRound: Map<string, ProcessEvent[]>;
  /** 流式正文按 turn 分桶（同构分桶，live 轮投影投为末段 assistantMessage） */
  textByRound: Map<string, string>;
  /** 当前 turn 归属（内核 chunk 携带 roundId，新 turn 起更新；无 chunk 前为 undefined） */
  currentRoundKey?: string;
  /** 开轮用户输入（仅 chat 开新轮路径有；resume 续跑轮由 mergeLiveRound 从落盘历史补） */
  seedUserMessage?: RoundView['userMessage'];
  /** 开轮输入来源标记（与 seedUserMessage 同生命周期；resume 轮缺省） */
  seedOrigin?: RoundView['origin'];
}

/** 单会话流运行态（字段沿用重构前 chatPanel 的对应单份字段，命名去掉下划线） */
export interface SessionRuntimeState {
  /** 该会话是否在流式生成中（consumeFlow 维护） */
  streaming: boolean;
  /** 该会话当前进行中流的 AbortController（无流时 undefined） */
  abortController?: AbortController;
  /** 该会话当前进行中流的 promise（仅 `runFlow` 内部赋值并 await；插话走 `agent.interject`，不读它） */
  currentFlow?: Promise<void>;
  /** 该会话本流 live 缓冲（consumeFlow 期间非空；正常/中断收场清除，软暂停保留） */
  liveBuffer?: LiveFlowBuffer;
}

/** 会话 → 运行态表（判据单点：同会话取同一对象，跨会话互不可见） */
export class SessionRuntimeStates {
  /** 已建立的会话记录（懒建；键 = 会话 id，值 = 该会话运行态） */
  private readonly states = new Map<string, SessionRuntimeState>();

  /**
   * 取某会话的运行态（不存在则建一条空记录）
   *
   * @param sessionId 会话标识（内核 `MessageHistory.currentSessionName` 口径）
   */
  get(sessionId: string): SessionRuntimeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { streaming: false };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /**
   * 只读查看某会话的运行态（不存在返回 undefined，**不建记录**）
   *
   * 列表标识 / 入口角标要遍历运行面（已装配实例 / ask 协调器 / 当前会话），若用 `get()`
   * 会为没跑过的会话逐个建空记录——读操作产生写副作用，记录表会随遍历面增长。
   *
   * @param sessionId 会话标识
   */
  peek(sessionId: string): SessionRuntimeState | undefined {
    return this.states.get(sessionId);
  }

  /**
   * 摘除某会话的运行态记录（会话被删除时的唯一清理面）
   *
   * 只摘记录、不处理在途流：删除入口已按目标会话拒绝仍在流式生成的会话
   * （`deleteSessionAction` 的 `isStreaming` 依赖），正常路径下此时已无活流。
   * 在途流的 abort 由面板 `runFlow` 创建、`chatRunControlOps.handleStop` 触发；
   * 内核另有自己的 `chatAbortController`。
   *
   * @param sessionId 会话标识
   */
  delete(sessionId: string): void {
    this.states.delete(sessionId);
  }
}

/**
 * 流归属会话闸（后台流投影闸）
 *
 * 用 `AsyncLocalStorage` 标记「当前执行栈属于哪个会话的流」。判据 = 流归属会话 ≠ 面板正在
 * 显示的会话 ⇒ 后台流：其 UI 投递与宿主单份投影缓存（`_turnState` / 快照签名 / 待发送区长度）
 * 必须整批丢弃，否则 A 的流会改写 B 的界面与相位。切回 A 时由 replay 从该会话 liveBuffer /
 * 落盘历史重建，内容不丢。
 *
 * ⚠️ 消费面必须逐个投影 helper 早退（而非只挡 `post()` 出口）：各 helper 持有宿主单份缓存，
 * 只挡出口会让缓存被后台流写脏——B 的下一轮去重/相位判据随之出错。
 */
export class BackgroundFlowGate {
  /** 流归属会话的异步上下文存储（`run` 作用域覆盖该流全部异步链） */
  private readonly storage = new AsyncLocalStorage<{ sessionId: string }>();

  /**
   * 在「流归属会话」作用域内执行
   *
   * @param sessionId 流归属会话
   * @param fn 流主体（其整个异步链内 `isBackground` 都能读到本归属）
   */
  run<T>(sessionId: string, fn: () => T): T {
    return this.storage.run({ sessionId }, fn);
  }

  /**
   * 当前执行栈是否属于后台流
   *
   * @param currentSessionId 面板当前显示的会话 id（对照基准，由面板现读）
   */
  isBackground(currentSessionId: string): boolean {
    const ctx = this.storage.getStore();
    return ctx !== undefined && ctx.sessionId !== currentSessionId;
  }
}
