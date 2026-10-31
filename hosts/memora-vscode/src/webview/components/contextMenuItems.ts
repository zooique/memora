/**
 * 右键菜单项表（COPY-2 · 菜单「能做什么」= 数据，不是编排）
 *
 * 为什么单独一个模块：这张表是「`{ 显示判据 when, 动作 run }`」清单，每条都带闭包依赖，
 * 塞在 `chatView` 里会同时踩两个坑——① 表长出 4 行/项，让 prettier 与 `max-lines` 闸门互相
 * 顶牛（格式化后超闸，为了不超闸就不能格式化）；② 「哪个动作什么时候可用」的判据散在
 * 视图函数体里，与 hover 按钮的可用态无从对照。表归此处后，视图侧只留注入（见 chatView
 * 的 `createContextMenuItems` 调用点）。
 *
 * 判据分工（**不要在这里重复实现**）：
 *   - 场合命中（selection > code > message）= `contextMenu.resolveContextMenuCtx` 单点；
 *   - 轮级动作（重新生成 / 分叉 / 删除）的文案、图标、可用判据、执行 =
 *     `roundActions.ROUND_ACTIONS` 单点（本表只按 id 派生菜单项，不再写第二份锁 / 锚点判断）；
 *   - 会话结构锁 = 宿主 `status` 派生的 `sessionControlsLocked`（**弹出时**判定，故注入取值
 *     函数而不是布尔快照——快照会让「打开菜单后状态变了」仍按旧态显示）。
 *
 * 未落项：「在编辑器打开」不在此表——对话内代码块不是工作区文件指针，`open_ref` 语义
 * （ref = 指针而非内容载体）不容硬塞，且无零新 type 的挂载点（台账 COPY-2 收口时已记偏差）。
 */
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import type { ContextMenuCtx, ContextMenuItem } from './contextMenu.js';
import { ROUND_ACTIONS, type RoundAction, type RoundActionCtx } from './roundActions.js';

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
 * 消息场合下各轮级动作的**额外出现范围**（呈现差异，不是第二份可用判据）。
 *
 * 可用性（锁 / 锚点是否为空）统一在 `roundActions.available` 单点判定；这里只回答
 * 「右键这个场合该不该出现该项」。重新生成维持「仅 AI 段」——与底栏主入口的分工定案
 * （2026-10-31 用户拍板），user 条右键不出现，但底栏照常可用。
 */
const MENU_SCOPE: Record<RoundAction['id'], (c: ContextMenuCtx) => boolean> = {
  regenerate: (c) => !!c.messageEl?.classList.contains('assistant'),
  fork: () => true,
  'delete-turn': () => true,
};

/** 右键 ctx → 轮级动作锚点（与底栏同一形状，字段来源单一） */
function toActionCtx(c: ContextMenuCtx): RoundActionCtx {
  return { turnTs: c.turnTs, roundId: c.roundId };
}

/**
 * 构造菜单项全集。
 *
 * 显隐判据 = 场合命中 + `available()`；`run` 里不判空（`available()` 已保证锚点非空），
 * 避免「判了两遍、两遍不一致」的第二真理源。
 */
export function createContextMenuItems(actions: ContextMenuActions): ContextMenuItem[] {
  const { copy, quoteReply, post, isLocked } = actions;
  /**
   * 正文类菜单项（消息条 / 代码块场合）的公共前置判据：**锁态整体不提供**。
   *
   * 这是用户 2026-10-31 拍板的设计，不是缺陷：运行状态（会话结构锁）下右键消息条
   * 「没有反应」，唯一例外是**选中文字后的选区菜单**（复制选中 / 引用回复）。
   * 过滤后可见项为空时 `initContextMenu` 不 preventDefault → 放行原生右键，天然静默。
   *
   * 判据单点：正文三项共用此守卫；轮级动作的锁由 `roundActions.available` 自身裁决，
   * 不在这里重判第二次（两份锁判据必然漂移）。
   */
  const bodyMenuAllowed = (c: ContextMenuCtx): boolean => c.kind === 'selection' || !isLocked();
  // 轮级动作从真源派生：顺序与底栏一致，两面不漂
  const roundItems: ContextMenuItem[] = ROUND_ACTIONS.map((action) => ({
    id: action.id,
    label: action.label,
    danger: action.danger,
    when: (c) =>
      c.kind === 'message' &&
      MENU_SCOPE[action.id](c) &&
      action.available(toActionCtx(c), isLocked()),
    run: (c) => action.run(toActionCtx(c), { post }),
  }));
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
      when: (c) => bodyMenuAllowed(c) && c.kind === 'message' && !!c.visibleText,
      run: (c) => copy(c.visibleText),
    },
    {
      id: 'copy-message-md',
      label: '复制为 Markdown',
      when: (c) => bodyMenuAllowed(c) && c.kind === 'message' && !!c.rawText,
      run: (c) => copy(c.rawText),
    },
    {
      id: 'copy-code',
      label: '复制代码',
      when: (c) => bodyMenuAllowed(c) && c.kind === 'code' && !!c.codeText,
      run: (c) => copy(c.codeText),
    },
    ...roundItems,
  ];
}
