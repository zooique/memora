/**
 * 未发送输入草稿存取的用例（`helpers/composerDrafts.ts`）
 *
 * 锁三件事：按会话归属、空文本不留垃圾键、越界与会话删除都收口在同一个模块。
 * 这里不碰面板——「恢复不置在打字」由 chatView / 面板用例各锁一半。
 */
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { MAX_INPUT_CHARS, UI_COMPOSER_DRAFTS_KEY } from '../../shared/constants.js';
import { createComposerDrafts } from '../helpers/composerDrafts.js';

/** 用 Map 模拟工作区级持久层（`get` 同步、`update` 立即生效，便于断言落盘形状） */
function makeState(initial?: Record<string, string>): {
  state: vscode.Memento;
  raw: Map<string, unknown>;
} {
  const raw = new Map<string, unknown>();
  if (initial) raw.set(UI_COMPOSER_DRAFTS_KEY, initial);
  const state = {
    get: (key: string) => raw.get(key),
    update: async (key: string, value: unknown) => {
      if (value === undefined) raw.delete(key);
      else raw.set(key, value);
    },
  } as never;
  return { state, raw };
}

describe('composerDrafts — 按会话归属', () => {
  it('写入 / 读取互不串会话；空文本删键，表空了连键一起移除', () => {
    const { state, raw } = makeState();
    const drafts = createComposerDrafts(() => state);

    drafts.accept('session-a', 'A 的草稿');
    drafts.accept('session-b', 'B 的草稿');
    expect(drafts.read('session-a')).toBe('A 的草稿');
    expect(drafts.read('session-b')).toBe('B 的草稿');
    expect(drafts.read('session-c')).toBe('');

    // 清空一个 → 只删这一条，另一条不受影响（归属边界）
    drafts.accept('session-a', '   ');
    expect(drafts.read('session-a')).toBe('');
    expect(drafts.read('session-b')).toBe('B 的草稿');

    // 全空 → 整键移除，不留 `{}` 垃圾
    drafts.accept('session-b', '');
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toBeUndefined();
  });

  it('空白草稿页（无会话 id）不落盘：免得重启后落到无关的新会话上', () => {
    const { state, raw } = makeState();
    const drafts = createComposerDrafts(() => state);
    expect(drafts.accept('', '还没点发送的新会话草稿')).toBe(true);
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toBeUndefined();
  });

  it('超长文本按输入框上限截断（不让一次粘贴撑大工作区存储）', () => {
    const { state } = makeState();
    const drafts = createComposerDrafts(() => state);
    drafts.accept('session-a', 'x'.repeat(MAX_INPUT_CHARS + 50));
    expect(drafts.read('session-a')).toHaveLength(MAX_INPUT_CHARS);
  });

  it('clear / forget / restore：发送即删、删会话即清、restore 只造消息不落盘', () => {
    const { state, raw } = makeState({ 'session-a': '草稿' });
    const drafts = createComposerDrafts(() => state);

    expect(drafts.restore('session-a')).toEqual({
      type: 'composer_draft_restore',
      sessionId: 'session-a',
      text: '草稿',
    });

    drafts.clear('session-a');
    expect(drafts.read('session-a')).toBe('');
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toBeUndefined();

    // forget = clear 的语义别名（删会话路径专用，便于在调用点读出意图）
    drafts.accept('session-b', '要删的会话的草稿');
    drafts.forget('session-b');
    expect(drafts.read('session-b')).toBe('');
  });

  it('未注入持久层：全程空操作（单测 / 嵌入宿主与改造前一致）', () => {
    const drafts = createComposerDrafts(() => undefined);
    expect(drafts.accept('session-a', '草稿')).toBe(true);
    expect(drafts.read('session-a')).toBe('');
    expect(() => drafts.clear('session-a')).not.toThrow();
  });
});
