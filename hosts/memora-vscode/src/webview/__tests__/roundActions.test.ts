/**
 * 轮级动作真源测试（ACTIONS-SSOT-1）
 *
 * 验证四件事：
 *   ① 可用判据矩阵（锁 × 锚点）单点裁决，三动作同一规则来源；
 *   ② 执行载荷与既有协议三通道一致（不新增 type）；
 *   ③ 右键菜单从同一真源派生（id / 文案 / 顺序不会与底栏漂移）；
 *   ④ 锁态下消息场合**全项隐藏**（运行态右键静默），选区菜单是唯一例外。
 *
 * 变异验证指引：把 `available` 里的 `!locked` 删掉，本文件与 chatView 底栏用例必须同时红
 * ——只红一面即说明又回到「两份判据」；把 contextMenuItems 的 `bodyMenuAllowed` 去掉
 * `!isLocked()`，④ 必须红（运行态右键复活 = 违背 2026-10-31 用户定案）。
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ROUND_ACTIONS, findRoundAction } from '../components/roundActions.js';
import { createContextMenuItems } from '../components/contextMenuItems.js';
import type { ContextMenuCtx } from '../components/contextMenu.js';

/** 造一个消息场合的右键 ctx（字段齐全 = 锚点可用） */
function messageCtx(assistant: boolean): ContextMenuCtx {
  const el = document.createElement('div');
  el.className = assistant ? 'msg assistant' : 'msg user';
  return {
    kind: 'message',
    messageEl: el,
    codeText: '',
    selectionText: '',
    rawText: '原文',
    visibleText: '可见文本',
    roundId: 'r1',
    turnTs: 't1',
  };
}

/** 造一个选区场合的右键 ctx（选中文字 = 锁态下唯一可弹菜单的例外） */
function selectionCtx(): ContextMenuCtx {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  return {
    kind: 'selection',
    messageEl: el,
    codeText: '',
    selectionText: '选中的文字',
    rawText: '原文',
    visibleText: '可见文本',
    roundId: 'r1',
    turnTs: 't1',
  };
}

describe('roundActions 轮级动作真源', () => {
  it('可用判据矩阵：锁态优先，锚点按动作分字段（删除/重新生成看 turnTs，分叉看 roundId）', () => {
    const full = { turnTs: 't1', roundId: 'r1' };
    for (const action of ROUND_ACTIONS) {
      expect(action.available(full, false)).toBe(true);
      // 锁态恒禁用，不论锚点是否齐全
      expect(action.available(full, true)).toBe(false);
    }
    const regenerate = findRoundAction('regenerate');
    const fork = findRoundAction('fork');
    const del = findRoundAction('delete-turn');
    expect(regenerate?.available({ turnTs: '', roundId: 'r1' }, false)).toBe(false);
    expect(fork?.available({ turnTs: 't1', roundId: '' }, false)).toBe(false);
    expect(del?.available({ turnTs: '', roundId: 'r1' }, false)).toBe(false);
  });

  it('执行载荷 = 既有三通道（input regenerate / fork_session / delete_turn），不新增 type', () => {
    const posted: unknown[] = [];
    const deps = {
      post: (m: unknown): void => {
        posted.push(m);
      },
    };
    for (const action of ROUND_ACTIONS) action.run({ turnTs: 't1', roundId: 'r1' }, deps);
    expect(posted).toEqual([
      { type: 'input', kind: 'regenerate', turnTs: 't1' },
      { type: 'fork_session', roundId: 'r1' },
      { type: 'delete_turn', ts: 't1' },
    ]);
  });

  it('右键菜单从同一真源派生：轮级项 id / 文案 / 顺序与真源一致', () => {
    const items = createContextMenuItems({
      copy: () => {},
      quoteReply: () => {},
      post: () => {},
      isLocked: () => false,
    });
    // 轮级项恒排在文本/选区类之后，顺序 = 真源顺序（底栏同序）
    const roundItems = items.slice(-ROUND_ACTIONS.length);
    expect(roundItems.map((i) => i.id)).toEqual(ROUND_ACTIONS.map((a) => a.id));
    // 文案取自真源：改一处两面同步，不存在第二份菜单文案
    roundItems.forEach((item, i) => expect(item.label).toBe(ROUND_ACTIONS[i]?.label));
  });

  it('重新生成维持仅 AI 段（呈现差异，锚点/锁判据仍归真源）', () => {
    const items = createContextMenuItems({
      copy: () => {},
      quoteReply: () => {},
      post: () => {},
      isLocked: () => false,
    });
    const regenerate = items.find((i) => i.id === 'regenerate');
    expect(regenerate?.when(messageCtx(true))).toBe(true);
    expect(regenerate?.when(messageCtx(false))).toBe(false);
    // 锁态由注入的 isLocked() 弹出时求值：锁生效 → 菜单项隐藏（与底栏置灰同判据）
    const lockedItems = createContextMenuItems({
      copy: () => {},
      quoteReply: () => {},
      post: () => {},
      isLocked: () => true,
    });
    expect(lockedItems.find((i) => i.id === 'delete-turn')?.when(messageCtx(true))).toBe(false);
  });

  it('锁态（运行中）：消息/代码场合菜单项全项隐藏，选区菜单是唯一例外（2026-10-31 用户定案）', () => {
    const lockedItems = createContextMenuItems({
      copy: () => {},
      quoteReply: () => {},
      post: () => {},
      isLocked: () => true,
    });
    // 设计定案：运行状态右键「直接没有反应」——正文非空、锚点齐全也一律不显示
    // （变异：bodyMenuAllowed 去掉 !isLocked() → 正文三项复活 → 本断言红）
    const msg: ContextMenuCtx = messageCtx(true);
    expect(lockedItems.filter((i) => i.when(msg)).map((i) => i.id)).toEqual([]);
    // 代码块场合同样静默（正文三项共用同一个锁守卫）
    const code: ContextMenuCtx = { ...msg, kind: 'code', codeText: 'const a = 1;' };
    expect(lockedItems.filter((i) => i.when(code)).map((i) => i.id)).toEqual([]);
    // 唯一例外：选中文字后的选区菜单不受锁影响（仍可复制 / 引用）
    expect(lockedItems.filter((i) => i.when(selectionCtx())).map((i) => i.id)).toEqual([
      'copy-selection',
      'quote-reply',
    ]);
  });
});
