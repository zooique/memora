/**
 * 右键菜单项表（COPY-2 · 菜单「能做什么」= 数据，不是编排）
 *
 * 为什么单独一个模块：这张表是 8 条 `{ 显示判据 when, 动作 run }`，每条都带闭包依赖，
 * 塞在 `chatView` 里会同时踩两个坑——① 表长出 4 行/项，让 prettier 与 `max-lines` 闸门互相
 * 顶牛（格式化后超闸，为了不超闸就不能格式化）；② 「哪个动作什么时候可用」的判据散在
 * 视图函数体里，与 hover 按钮的可用态无从对照。表归此处后，视图侧只留注入（见 chatView
 * 的 `createContextMenuItems` 调用点）。
 *
 * 判据分工（**不要在这里重复实现**）：
 *   - 场合命中（selection > code > message）= `contextMenu.resolveContextMenuCtx` 单点；
 *   - 会话结构锁 = 宿主 `status` 派生的 `sessionControlsLocked`（**弹出时**判定，故注入取值
 *     函数而不是布尔快照——快照会让「打开菜单后状态变了」仍按旧态显示）。
 *
 * 未落项：「在编辑器打开」不在此表——对话内代码块不是工作区文件指针，`open_ref` 语义
 * （ref = 指针而非内容载体）不容硬塞，且无零新 type 的挂载点（台账 COPY-2 收口时已记偏差）。
 */
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import type { ContextMenuItem } from './contextMenu.js';

/** 菜单动作出口：调用方注入实现，表只声明「什么时候能做什么」 */
export interface ContextMenuActions {
  /** 复制（真源 = `helpers/selectionClipboard` 的 copyText 单点，不在表里另写剪贴板逻辑） */
  copy(text: string): void;
  /** 引用回复（胶囊暂存，发送时展开为规范引用块——文本快照不进协议） */
  quoteReply(text: string): void;
  /** 发消息（零新 type：复用既有 fork_session / delete_turn / input 三通道） */
  post(msg: WebviewToExtensionMessage): void;
  /** 会话结构锁是否生效（运行时禁用改变会话结构的操作） */
  isLocked(): boolean;
}

/**
 * 构造菜单项全集。
 *
 * 显隐判据只依赖 ctx 与锁态两件事；`run` 里不判空（`when` 已保证锚点非空），
 * 避免「判了两遍、两遍不一致」的第二真理源。
 */
export function createContextMenuItems(actions: ContextMenuActions): ContextMenuItem[] {
  const { copy, quoteReply, post, isLocked } = actions;
  return [
    {
      id: 'copy-selection',
      label: '复制选中',
      when: (c) => c.kind === 'selection',
      run: (c) => copy(c.selectionText),
    },
    {
      id: 'quote-reply',
      label: '引用回复',
      when: (c) => c.kind === 'selection',
      run: (c) => quoteReply(c.selectionText),
    },
    {
      id: 'copy-message',
      label: '复制本条',
      when: (c) => c.kind === 'message' && !!c.visibleText,
      run: (c) => copy(c.visibleText),
    },
    {
      id: 'copy-message-md',
      label: '复制为 Markdown',
      when: (c) => c.kind === 'message' && !!c.rawText,
      run: (c) => copy(c.rawText),
    },
    {
      id: 'copy-code',
      label: '复制代码',
      when: (c) => c.kind === 'code' && !!c.codeText,
      run: (c) => copy(c.codeText),
    },
    {
      id: 'regenerate',
      label: '重新生成',
      // 仅 assistant（与既有 hover 按钮归属一致）；锚 = 该条 assistant 消息的 turnTs
      when: (c) =>
        c.kind === 'message' &&
        !!c.messageEl?.classList.contains('assistant') &&
        !!c.turnTs &&
        !isLocked(),
      run: (c) => post({ type: 'input', kind: 'regenerate', turnTs: c.turnTs }),
    },
    {
      id: 'fork',
      label: '分叉',
      when: (c) => c.kind === 'message' && !!c.roundId && !isLocked(),
      run: (c) => post({ type: 'fork_session', roundId: c.roundId }),
    },
    {
      id: 'delete-turn',
      label: '删除',
      danger: true,
      // 锚 = .msg.dataset.ts（user / assistant 消息条都带，删除语义「该问答及之后全部」）
      when: (c) => c.kind === 'message' && !!c.turnTs && !isLocked(),
      run: (c) => post({ type: 'delete_turn', ts: c.turnTs }),
    },
  ];
}
