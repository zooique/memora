/**
 * 会话展示标题的创建时刻口径（sessionDisplayTitle）
 *
 * 断言目标：占位标题 `New session HH:MM`（zh 译文 = `新会话 HH:MM`，词形归
 * `l10n/bundle.l10n.zh-cn.json`）的时间必须来自**会话创建时刻**，且三档来源按
 * id `-s<base36>` → `meta.createdAt` → id 日期 00:00 依次兜底。
 *
 * 词形注入：本文件传 `IDENTITY_L10N`（按键直出 = 英文源文案）——这里验的是**格式与
 * 时刻来源**，不是译文；zh 译文由 nls 守卫（键集对齐）与 bundle 文件本身承担。
 *
 * 变异靶标：删掉 `meta.createdAt` 分支 ⇒ 「分叉会话用 createdAt」用例转红（显示 00:00）；
 * 改成 `new Date()` 现算 ⇒ 「同一会话两次读取结果一致」用例转红。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { SessionMeta } from '@zooique/memora';
import { IDENTITY_L10N, sessionDisplayTitle } from '../sessionTitle.js';

/** 构造最小合法元数据（只保留标题判据需要的字段） */
function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: '2026-11-07-s1',
    updatedAt: '2026-11-07T00:00:00.000Z',
    messageCount: 0,
    ...overrides,
  };
}

/** 本地时间 → 会话 id 的 `-s<base36>` 时间后缀（与 buildSessionId 同义） */
function timedSessionId(localDate: Date, dayPrefix: string): string {
  return `${dayPrefix}-s${localDate.getTime().toString(36)}`;
}

describe('sessionDisplayTitle 创建时刻口径', () => {
  it('displayName 优先，不被占位串覆盖', () => {
    const meta = makeMeta({ displayName: '手动命名' });
    expect(sessionDisplayTitle(meta.sessionId, meta, IDENTITY_L10N)).toBe('手动命名');
  });

  it('无 displayName 时回退 autoName', () => {
    const meta = makeMeta({ autoName: '自动命名' });
    expect(sessionDisplayTitle(meta.sessionId, meta, IDENTITY_L10N)).toBe('自动命名');
  });

  it('普通会话：时间取自 id 的 -s<base36> 段', () => {
    // 用本地时间构造，避免时区差异（占位标题按本地时区格式化）
    const createdAt = new Date(2026, 10, 7, 14, 32);
    const sessionId = timedSessionId(createdAt, '2026-11-07');
    expect(sessionDisplayTitle(sessionId, makeMeta({ sessionId }), IDENTITY_L10N)).toBe(
      'New session 14:32',
    );
  });

  it('分叉会话：id 无时间后缀，时间取 meta.createdAt', () => {
    // 内核分叉命名 = `session-<base36>`（不含 -s 段），但 forkSession 会落盘 createdAt
    const createdAt = new Date(2026, 10, 7, 14, 32);
    const sessionId = '2026-11-07-session-mz9abcd';
    const meta = makeMeta({ sessionId, createdAt: createdAt.toISOString() });
    expect(sessionDisplayTitle(sessionId, meta, IDENTITY_L10N)).toBe('New session 14:32');
  });

  it('旧会话：既无时间后缀也无 createdAt 时，回退到 id 日期 00:00', () => {
    const sessionId = '2026-11-07-main';
    expect(sessionDisplayTitle(sessionId, makeMeta({ sessionId }), IDENTITY_L10N)).toBe(
      'New session 00:00',
    );
  });

  it('createdAt 非法（历史脏数据）时不得抛错，回退到 id 日期 00:00', () => {
    const sessionId = '2026-11-07-main';
    const meta = makeMeta({ sessionId, createdAt: 'not-a-date' });
    expect(sessionDisplayTitle(sessionId, meta, IDENTITY_L10N)).toBe('New session 00:00');
  });

  it('同一会话跨时间读取结果一致（不得用读取时刻现算）', () => {
    const createdAt = new Date(2026, 10, 7, 8, 1);
    const sessionId = timedSessionId(createdAt, '2026-11-07');
    const meta = makeMeta({ sessionId });
    // 推进系统时钟验证：若实现改成按当前时刻现算，两次结果会随分钟变化而转红
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 7, 9, 0));
      const first = sessionDisplayTitle(sessionId, meta, IDENTITY_L10N);
      vi.setSystemTime(new Date(2026, 10, 7, 9, 5));
      const second = sessionDisplayTitle(sessionId, meta, IDENTITY_L10N);
      expect(first).toBe('New session 08:01');
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
