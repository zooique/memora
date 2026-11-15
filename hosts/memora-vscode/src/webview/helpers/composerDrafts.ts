/**
 * 未发送输入草稿的存取（唯一入口）
 *
 * 归属按会话：`Record<sessionId, string>`，空串键 = 「＋」后的空白草稿页（还没有会话 id）。
 * 存储只落 `workspaceState`（工作区级，与形态/座位同一个 Memento），不写 `.memora`。
 *
 * 三条纪律：
 * - **空文本删键**：不留 `''` 垃圾，避免键数随会话增长；
 * - **会话删除即 `forget`**：调用点 = 面板删会话成功路径；
 * - **它不是 `composer_state`**：那个是「输入框有没有字」的翻转信号（只服务落定汇报不打断
 *   打字），文本搬运一律走 `composer_draft`（W→E）/ `composer_draft_restore`（E→W）。
 *
 * 为什么外置：`chatPanel.ts` 贴 max-lines 基线，面板只留字段与几处单行调用。
 */
import type * as vscode from 'vscode';
import { MAX_INPUT_CHARS, UI_COMPOSER_DRAFTS_KEY } from '../../shared/constants.js';

/** 草稿存取外露面 */
export interface ComposerDrafts {
  /** 读某会话（'' = 空白草稿页）的未发送文本；没有则空串 */
  read(sessionId: string): string;
  /**
   * 接收 webview 上报的文本并落盘
   *
   * @returns 文本是否非空（调用方按需使用；面板刻意**不**用它改 `_composerHasText`——
   *          「有没有字」的翻转只认 `composer_state`，见模块头第三条纪律）
   */
  accept(sessionId: string, text: string): boolean;
  /** 发送成功：立即删键（不延迟，避免重启把已发出的文本又放回输入框） */
  clear(sessionId: string): void;
  /** 会话永久删除：清掉它的草稿 */
  forget(sessionId: string): void;
  /**
   * 构造「填回输入框」的下行消息
   *
   * 放在这里只为让面板保持一行（`chatPanel.ts` 贴 max-lines 基线）；文本仍只有本模块一个来源。
   * `sessionId` 随消息下发：webview 记下归属并在 `composer_draft` 里原样回传（见 protocol）。
   */
  restore(sessionId: string): { type: 'composer_draft_restore'; sessionId: string; text: string };
}

/**
 * 构造草稿存取
 *
 * @param getState 工作区级持久层（未注入 ⇒ 全程空操作，单测 / 嵌入宿主行为与改造前一致）
 */
export function createComposerDrafts(getState: () => vscode.Memento | undefined): ComposerDrafts {
  /** 读整张表（脏数据一律当空表，不猜单条） */
  function readAll(): Record<string, string> {
    const raw = getState()?.get<unknown>(UI_COMPOSER_DRAFTS_KEY);
    return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
  }

  /** 写整张表（唯一写口：`workspaceState.update` 是全量覆盖，表本身很小；空表整键移除） */
  function writeAll(all: Record<string, string>): void {
    const empty = Object.keys(all).length === 0;
    void getState()?.update(UI_COMPOSER_DRAFTS_KEY, empty ? undefined : all);
  }

  return {
    read(sessionId) {
      const text = readAll()[sessionId];
      return typeof text === 'string' ? text : '';
    },
    accept(sessionId, text) {
      // 空白草稿页（还没有会话 id）没有归属：不落盘，免得重启后落到一条无关的新会话上
      if (!sessionId) return text.trim().length > 0;
      // 与输入框长度上限同源：超长文本不落盘（否则一次粘贴会把工作区存储撑大）
      const capped = text.slice(0, MAX_INPUT_CHARS);
      const all = readAll();
      if (capped.trim().length === 0) {
        if (!(sessionId in all)) return false;
        delete all[sessionId];
      } else {
        // 内容没变就不写：防抖 250ms 内重复上报同一文本时不产生无意义的持久化写
        if (all[sessionId] === capped) return true;
        all[sessionId] = capped;
      }
      writeAll(all);
      return capped.trim().length > 0;
    },
    clear(sessionId) {
      const all = readAll();
      if (!(sessionId in all)) return;
      delete all[sessionId];
      writeAll(all);
    },
    forget(sessionId) {
      this.clear(sessionId);
    },
    restore(sessionId) {
      return { type: 'composer_draft_restore', sessionId, text: this.read(sessionId) };
    },
  };
}
