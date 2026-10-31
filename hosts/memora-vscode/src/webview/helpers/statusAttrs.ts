/**
 * 正文块运行态 / 终态属性写入（CHATVIEW-SLIM-2 第 5 刀·零状态批，自 chatView.ts 外置）
 *
 * 两条通道严格分离（2026-10-19 SSOT 收敛）：运行/挂起态写 `data-status`、终态写
 * `data-terminus`。文案与样式全由 CSS 承载，
 * 本模块只负责把状态**写到载体属性**上——不持有状态、不查全局 DOM。
 *
 * @module statusAttrs
 */

/**
 * 运行/挂起态（单一合成函数的输出域）：运行三态呼吸 / 挂起两态静态。**不含终态**——
 * 终态三档已分离到 TerminusKind（data-terminus），运行结束由调用方显式清除本通道。
 */
export type CursorStatus =
  | '思考中' // 运行：思考相位（process-flow 相位行非工具形态在途）
  | '运行工具中' // 运行：工具在途（is-tool-running 存在）
  | '正在回答中' // 运行：正文流式生成（默认态）
  | '等待输入' // 挂起：ask 预检停顿（提问框在途）
  | '已暂停';

/**
 * 终态三档（data-terminus 输出域，与运行态 data-status 通道严格分离，2026-10-19）。
 * 渲染位点（TERMINUS-SSOT-1，2026-10-31 收口）：三档终态均由 round-group 底栏 :has 消费
 * （已完成=淡勾 / 用户中断=中性文字 / 异常中断=红字）；无容器兜底轮由载体尾自足承接
 * （见 chatStyles 载体尾规则）。终态写入点 = 收场消息（done/interrupted），流内 error
 * 事件不定格终态。
 */
export type TerminusKind =
  | '已完成' // 终态：底栏 time 之后淡勾（正文尾不再显示）
  | '用户中断' // 终态：用户主动停止（载体 = 中断轮宿主块，底栏文字标签）
  | '异常中断';

/**
 * 对指定正文块写入运行/挂起态（唯一实现；null = 清除，幂等）
 *
 * @param body    正文块（.msg-body）；null/未连接时 no-op（诚实投影：无载体不撒状态）
 * @param status  运行/挂起态之一；null 清除
 */
export function setCursorStatus(
  body: HTMLElement | null | undefined,
  status: CursorStatus | null,
): void {
  if (!body || !body.isConnected) return;
  if (status) body.dataset.status = status;
  else delete body.dataset.status;
}

/**
 * 终态写入（结束后状态的唯一实现；与 setCursorStatus 的运行态通道严格分离）
 *
 * SSOT 收敛（2026-10-19）：一个属性背两种语义 = 双真相源，且终态覆盖运行态令「运行结束」
 * 表现为「被覆盖」而非「自然消失」。分属性后：运行态由调用方显式清除（finalizeStreaming
 * 清 / error 分支清），终态独立定格，互不污染。
 *
 * detail 参数已退役（TERMINUS-SSOT-1，2026-10-31）：唯一写入方 error 分支不再定格终态
 * （终态归属收场消息），异常原因显示面 = 平铺错误行（运行时）+ 停止行 reason（中断轮），
 * 独立属性通道零消费随之删除。
 *
 * @param el      终态载体（有正文轮 = .msg-body；中断轮 = 宿主块 .msg.assistant）
 * @param kind    终态三档之一
 */
export function setTerminus(
  el: HTMLElement | null | undefined,
  kind: TerminusKind,
): void {
  if (!el || !el.isConnected) return;
  el.dataset.terminus = kind;
}
