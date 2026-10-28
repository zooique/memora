/**
 * 图片输入：token 折算（方案 §5.9）+ 装配三跳透传（方案 §5.4 / §5.12 / §7 P0-12）
 *
 * 覆盖：
 *  - (b) 单图 token 数 `imageTokens` 的 patch 公式与 1568 上界封顶；
 *        `estimateTokensMessages` 把图片按尺寸折算进 CJK token 轨道（单一 token 数学，不引入第二套）。
 *  - (c) 装配三跳：
 *        ① `MessageHistory.appendUser(..., { attachments })` → Round.userMessage 白名单**显式透传**（缺口 #2 修复）；
 *        ② `loadRoundBasedMessages` 在 RETAIN_IMAGE_ROUNDS 窗口内带 attachments，更早轮次窗衰减掉（content 不变）；
 *        ③ 衰减是 load 期视图，存储层 attachments 不丢（重启/切会话图仍可从存储还原）。
 *  - `applySessionToLoop` 仅作 `{...tm}` 展开透传（已由 publicMemberSurfaceGuard 守 Message.attachments 字段），
 *    故不在此重复构造完整 SessionManager。
 */
import { describe, it, expect } from 'vitest';
import {
  imageTokens,
  IMAGE_TOKEN_UPPER_BOUND,
  estimateTokensMessages,
} from '@/agent/contextManager.js';
import { MessageHistory } from '@/agent/messageHistory.js';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import type { ImageRef } from '@/llm/provider.js';
import { nowIso } from '@/utils/time.js';
import type { Round } from '@/memory/roundStore.js';

function makeRef(over: Partial<ImageRef> = {}): ImageRef {
  return { sha256: 'x', mime: 'image/png', width: 100, height: 100, bytes: 10, name: 'p.png', ...over };
}

function makeRound(id: string, attachments?: readonly ImageRef[]): Round {
  return {
    id,
    userMessage: {
      id: `msg-${id}-user`,
      role: 'user',
      content: `round ${id}`,
      timestamp: nowIso(),
      ...(attachments ? { attachments } : {}),
    },
    status: 'complete',
    createdAt: nowIso(),
    // refCount=1：模拟「已被某会话登记」的在役问答闭环（0 会被 GC 判为孤儿，与本用例无关）
    refCount: 1,
  };
}

describe('imageTokens · patch 公式与 1568 上界（方案 §5.9）', () => {
  it('⌈w/28⌉×⌈h/28⌉ 标准折算', () => {
    expect(imageTokens(makeRef({ width: 100, height: 100 }))).toBe(
      Math.ceil(100 / 28) * Math.ceil(100 / 28),
    ); // 4×4 = 16
  });

  it('最小图（1×1）→ 1 瓦片', () => {
    expect(imageTokens(makeRef({ width: 1, height: 1 }))).toBe(1);
  });

  it('784×784 → 28×28 = 784（未触上界）', () => {
    expect(imageTokens(makeRef({ width: 784, height: 784 }))).toBe(784);
  });

  it('超大图（2000×2000）→ 封顶 1568（防爆窗估算）', () => {
    expect(imageTokens(makeRef({ width: 2000, height: 2000 }))).toBe(IMAGE_TOKEN_UPPER_BOUND);
    expect(IMAGE_TOKEN_UPPER_BOUND).toBe(1568);
  });
});

describe('estimateTokensMessages · 图片折算进 CJK 轨道（方案 §5.9）', () => {
  it('空内容 + 单图（100×100=16 token）折算为 16 token', () => {
    const est = estimateTokensMessages([{ content: '', attachments: [makeRef()] }]);
    expect(est).toBe(16);
  });

  it('中文文本 + 单图：图片折算叠加 CJK 估算', () => {
    // 你好 = 2 CJK 字符；图 = 16 token；CJK 字符经 1.5 折合：ceil((2 + 16*1.5)/1.5) = ceil(26/1.5) = 18
    const est = estimateTokensMessages([{ content: '你好', attachments: [makeRef()] }]);
    expect(est).toBe(18);
  });

  it('多图累加（两张 100×100 = 32 token）', () => {
    const est = estimateTokensMessages([
      { content: '', attachments: [makeRef(), makeRef()] },
    ]);
    expect(est).toBe(32);
  });

  it('无附件时图片数学不介入（回归守卫）', () => {
    expect(estimateTokensMessages([{ content: '' }])).toBe(0);
  });
});

describe('装配三跳 · 持久化透传 + 窗口衰减（方案 §5.12 / §7 P0-12）', () => {
  it('① appendUser 白名单显式透传 attachments 到 Round.userMessage（缺口 #2 修复）', async () => {
    const roundStore = new InMemoryRoundStore();
    const history = new MessageHistory(undefined, '2026-06-01', 'main', roundStore);
    const ref = makeRef();
    await history.appendUser('看这张图', 'r1', { attachments: [ref] });
    const stored = roundStore.getById('r1');
    expect(stored).toBeTruthy();
    expect(stored!.userMessage.attachments).toEqual([ref]);
  });

  it('② loadRoundBasedMessages 窗口内带 attachments，窗口外衰减掉（content 不变）', async () => {
    const roundStore = new InMemoryRoundStore();
    const history = new MessageHistory(undefined, '2026-06-01', 'main', roundStore);
    const ref = makeRef();
    // 6 个轮次，每个都带图；窗口 = RETAIN_IMAGE_ROUNDS = 4（仅最近 4 轮带图）
    const ids = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'];
    for (const id of ids) roundStore.save(makeRound(id, [ref]));

    const messages = history.loadRoundBasedMessages(ids);
    expect(messages).toHaveLength(6);

    // 当前索引 = 5；withImages = (5 - idx) < 4 → idx ∈ {2,3,4,5} 带图，{0,1} 衰减
    const [m0, m1, m2, , , m5] = messages;
    expect(m0?.attachments).toBeUndefined(); // 衰减
    expect(m1?.attachments).toBeUndefined(); // 衰减
    expect(m2?.attachments).toEqual([ref]); // 窗口内
    expect(m5?.attachments).toEqual([ref]); // 最近轮
    // content 恒不变（衰减仅剥图，不丢文本）
    expect(m0?.content).toBe('round r0');
    expect(m1?.content).toBe('round r1');
  });

  it('③ 衰减是 load 期视图：存储层 attachments 不丢（重启/切会话可还原）', async () => {
    const roundStore = new InMemoryRoundStore();
    const history = new MessageHistory(undefined, '2026-06-01', 'main', roundStore);
    const ref = makeRef();
    const ids = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'];
    for (const id of ids) roundStore.save(makeRound(id, [ref]));

    history.loadRoundBasedMessages(ids); // 触发衰减视图
    // 存储层仍完整保留每个轮的 attachments
    for (const id of ids) {
      expect(roundStore.getById(id)!.userMessage.attachments).toEqual([ref]);
    }
  });

  it('RETAIN_IMAGE_ROUNDS 契约值 = 4（§5.12 窗衰减窗口，调此须同步方案文档）', () => {
    expect(LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS).toBe(4);
  });
});
