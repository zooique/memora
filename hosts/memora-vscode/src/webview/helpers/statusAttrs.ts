/**
 * 正文块运行态 / 终态属性写入（CHATVIEW-SLIM-2 第 5 刀·零状态批，自 chatView.ts 外置）
 *
 * 两条通道严格分离（2026-10-19 SSOT 收敛）：运行/挂起态写 `data-status`、终态写
 * `data-terminus`。本模块只负责把状态**写到载体属性**上——不持有状态、不查全局 DOM。
 *
 * **键面与文案分离（B9-A 起）**：属性值是**语言无关的机器键**（`thinking` / `completed` …），
 * CSS 用键做选择器（`:has([data-terminus='completed'])`）；可见文案另写 `data-*-label`
 * 属性（调用时 `l10n.t` 解析），CSS 以 `content: attr(data-*-label)` 承接。
 * 分离动机：属性值直接进 CSS 选择器时，**翻译文案就会改选择器**——中英文切换即断样式，
 * 且「文案 = 键」使 l10n 无法介入（旧实现把中文写死进属性）。两属性由本模块**同一处成对写入**，
 * 不存在「有键无文案」的中间态（唯一写入方 ⇒ 成对性由结构保证，不靠纪律）。
 *
 * @module statusAttrs
 */
import * as l10n from '@vscode/l10n';

/**
 * 运行/挂起态（单一合成函数的输出域）：运行三态呼吸 / 挂起两态静态。**不含终态**——
 * 终态三档已分离到 TerminusKind（data-terminus），运行结束由调用方显式清除本通道。
 */
export type CursorStatus =
  | 'thinking' // 运行：思考相位（process-flow 相位行非工具形态在途）
  | 'running-tool' // 运行：工具在途（is-tool-running 存在）
  | 'answering' // 运行：正文流式生成（默认态）
  | 'waiting-input' // 挂起：ask 预检停顿（提问框在途）
  | 'paused';

/** 运行/挂起态 → 展示文案（英文源键 = l10n 键面；模块加载早于 l10n 初始化，故值不可预解析） */
// @nls-keys
const CURSOR_STATUS_LABEL: Record<CursorStatus, string> = {
  thinking: 'Thinking…',
  'running-tool': 'Running tool…',
  answering: 'Answering…',
  'waiting-input': 'Waiting for input',
  paused: 'Paused',
};

/**
 * 终态三档（data-terminus 输出域，与运行态 data-status 通道严格分离，2026-10-19）。
 * 渲染位点（TERMINUS-SSOT-1，2026-10-31 收口）：三档终态均由 round-group 底栏 :has 消费
 * （已完成=淡勾 / 用户中断=中性文字 / 异常中断=红字）；无容器兜底轮由载体尾自足承接
 * （见 chatStyles 载体尾规则）。写入时机 = 收场消息与重放：`done` 按盘面 `roundStatus`
 * 定格（complete → 已完成；显式非 complete 且已定义 → 异常中断；缺省按已完成处理，兼容回放）；
 * 中断轮与重放中断轮由 `appendInterruptedRow` 调 `decideTerminus` 定格。中断档位依据 =
 * 该轮 processEvents：有 `error` 事件优先判 `error-interrupted`，无则看 `aborted`
 * （`stopReason === 'user'` → 用户中断，其余 → 异常中断）。
 * `error` **协议消息**分支本身不写终态：原因句走平铺错误行，终态归随后的 `done`。
 *
 * 语义极限（如实登记，非缺陷）：盘面 `RoundStatus.interrupted` 合并了「用户停」与「内核失败」
 * 两种事实，二者靠过程事件（aborted / error）区分；崩溃打捞轮两者皆无（进程没来得及写），
 * 按定案「等同用户点停止」显「用户中断」。**不得**在展示层再补一条判据（那会造第二个真相源）。
 *
 * 若将来真要分「崩溃 / 失败 / 用户停」，两条边界须先分清（否则会把「补写点」错做成「拆档位」）：
 *   - **运行期失败**可分——前提是内核**补 `error` 写入点**（当前 `error` 档零生产者，运行时失败
 *     并轨 `interrupted`），而不是改 `interrupted` 的语义；
 *   - **崩溃打捞轮**不可分——进程已死、无人可写，加任何字段都救不回，属**信息丢失**而非判据缺失，
 *     展示层只能按定案显「用户中断」。
 * 且**拆 `RoundStatus` 档位本身是破坏式变更**：`isRoundSettled` 把 `interrupted` 当「定案正常收场」
 * 的落脚点会随之消失，历史轮也无法回溯重标 ⇒ 不可作为「想显示得更准」的手段。
 */
export type TerminusInterruptKind =
  | 'user-interrupted' // 终态：用户主动停止（载体 = 中断轮宿主块，底栏文字标签）
  | 'error-interrupted';

export type TerminusKind =
  | 'completed' // 终态：底栏 time 之后淡勾（正文尾不再显示）
  | TerminusInterruptKind;

/** 终态三档 → 展示文案（英文源键 = l10n 键面；同上，调用时才解析） */
// @nls-keys
const TERMINUS_LABEL: Record<TerminusKind, string> = {
  completed: 'Completed',
  'user-interrupted': 'Stopped by user',
  'error-interrupted': 'Interrupted by error',
};

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
  if (status) {
    body.dataset.status = status;
    // 成对写入可见文案：CSS content 读 label，选择器读键（见文件头「键面与文案分离」）
    body.dataset.statusLabel = l10n.t(CURSOR_STATUS_LABEL[status]);
  } else {
    delete body.dataset.status;
    delete body.dataset.statusLabel;
  }
}

/**
 * 终态写入（结束后状态的唯一实现；与 setCursorStatus 的运行态通道严格分离）
 *
 * SSOT 收敛（2026-10-19）：一个属性背两种语义 = 双真相源，且终态覆盖运行态令「运行结束」
 * 表现为「被覆盖」而非「自然消失」。分属性后：运行态由调用方显式清除（finalizeStreaming
 * 清 / error 分支清），终态独立定格，互不污染。
 *
 * detail 参数已退役（TERMINUS-SSOT-1，2026-10-31）：当时唯一写 `detail` 的 error 分支不再
 * 定格终态（终态归属收场消息），异常原因显示面 = 平铺错误行（运行时）+ 停止行 reason（中断轮），
 * 独立属性通道零消费随之删除。
 *
 * @param el      终态载体（有正文轮 = .msg-body；中断轮 = 宿主块 .msg.assistant）
 * @param kind    终态三档之一
 */
export function setTerminus(el: HTMLElement | null | undefined, kind: TerminusKind): void {
  if (!el || !el.isConnected) return;
  el.dataset.terminus = kind;
  const label = l10n.t(TERMINUS_LABEL[kind]);
  // 成对写入可见文案（同 setCursorStatus：键给选择器，label 给 content）
  el.dataset.terminusLabel = label;
  // 加引号的原因：`content` 的取值语法只接受字符串等取值，裸标识符（即使是单个单词）也不是
  // 合法取值；不合法时该声明在计算值阶段失效、属性回退 initial，故把文案序列化成带引号的
  // 字符串。CSS 侧消费的是 `content: var(--terminus-label)`（chatStyles 底栏 ::after）。
  // 底栏标签的文案通道：`round-group__footer::after` 与载体**不是同一元素**，CSS attr()
  // 跨不过去；容器级自定义属性可被 footer（后代）继承，故把同一文案写进容器。
  // 等价性：容器此刻不存在 ⇒ 载体不可能落在任何容器内 ⇒ `:has(...)` 底栏规则永不匹配，
  // 无漏写风险（组容器在消息入树前创建，不存在「后置包一层」）。
  el.closest<HTMLElement>('.round-group')?.style.setProperty(
    '--terminus-label',
    JSON.stringify(label),
  );
}
