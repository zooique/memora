import { describe, it, expect } from 'vitest';
import {
  GuardRail,
  GUARD_THRESHOLDS,
  renderPrompt,
  createDefaultGuards,
  type GuardContext,
  type GuardCounters,
  type GuardRailDef,
} from '@/agent/guardRail.js';
import { ToolResultCache, normalizePathKey, type DedupSubject } from '@/agent/toolResultCache.js';

/** 构造默认计数（全部为零值） */
function emptyCounters(): GuardCounters {
  return {
    searchCallCount: 0,
    askCountThisTurn: 0,
    write: { lastWritePath: null, samePathWriteStreak: 0 },
    readFailBySubject: new Map<string, number>(),
  };
}

/** 组装一个 GuardContext（缺省填 GuardRail 默认阈值 + 恒真"仍在上下文"判定）。
 *  GUARD_THRESHOLDS 静态表只含 writeLoop/readFailed；askLimit/maxWebSearch 为测试默认值（非真源）。 */
function makeCtx(overrides: Partial<GuardContext> & { counters?: GuardCounters }): GuardContext {
  const cache = new ToolResultCache();
  return {
    toolName: 'read_file',
    argsJson: '{}',
    toolCallId: 'tc-1',
    toolResultCache: cache,
    isCachedResultStillInContext: () => true,
    thresholds: {
      ...GUARD_THRESHOLDS,
      askLimit: 20,
      maxWebSearch: 8,
      ...(overrides.thresholds ?? {}),
    },
    counters: emptyCounters(),
    ...overrides,
  };
}

/** read_file 的请求主体（与 DEDUP_SUBJECT_EXTRACTORS 同构） */
function readSubject(path: string): DedupSubject {
  return { path: normalizePathKey(path), offset: 1, limit: undefined };
}

describe('GuardRail 阈值真源', () => {
  it('静态阈值真源只承载纯静态键（writeLoop/readFailed）；动态键不入表', () => {
    // 静态真源：writeLoop / readFailed（同路径连写 / 读取失败硬闸）为唯一 SSOT
    expect(GUARD_THRESHOLDS).toEqual({ writeLoop: 5, readFailed: 3 });
    // 动态键不设静态默认（askLimit 由 role-pack strategy 注入、maxWebSearch 由 LOOP_CONSTANTS 注入）
    expect(GUARD_THRESHOLDS).not.toHaveProperty('askLimit');
    expect(GUARD_THRESHOLDS).not.toHaveProperty('maxWebSearch');
    expect(GUARD_THRESHOLDS).not.toHaveProperty('duplicateToolCall');
  });
});

describe('renderPrompt 提示词统一真理源', () => {
  it('占位符被插值替换', () => {
    expect(renderPrompt('search_limit', { limit: 8 })).toContain('[SEARCH_LIMIT_REACHED]');
    expect(renderPrompt('search_limit', { limit: 8 })).toContain('8 次联网搜索');
    expect(renderPrompt('read_failed_limit', { n: 3, limit: 3 })).toContain(
      '[READ_FAILED_LIMIT] 该目标已连续失败 3 次（阈值 3）',
    );
    expect(renderPrompt('already_read', { n: 2, format: 'a.md', tail: 'x' })).toContain(
      '[ALREADY_READ] 该结果仍在你的当前上下文中（第 2 步获取：a.md）',
    );
  });
});

describe('GuardRail 判定复现现有护栏（S1 shadow 契约）', () => {
  const guards = registerAll(new GuardRail(), createDefaultGuardsShim());

  it('search_limit：达搜上限拦，未达放行', () => {
    const blocked = guards.evaluateBlocked(
      makeCtx({ toolName: 'web_search', argsJson: '{"query":"x"}', counters: { ...emptyCounters(), searchCallCount: 9 } }),
    );
    expect(blocked?.guardId).toBe('search_limit');
    const pass = guards.evaluateBlocked(
      makeCtx({ toolName: 'web_search', argsJson: '{"query":"x"}', counters: { ...emptyCounters(), searchCallCount: 5 } }),
    );
    expect(pass).toBeUndefined();
  });

  it('ask_limit：达提问上限拦', () => {
    const blocked = guards.evaluateBlocked(
      makeCtx({ toolName: 'ask_user', argsJson: '{}', counters: { ...emptyCounters(), askCountThisTurn: 20 } }),
    );
    expect(blocked?.guardId).toBe('ask_limit');
  });

  it('write_loop：同路径达阈值拦，换路径重置放行', () => {
    const ctx = makeCtx({
      toolName: 'write_file',
      argsJson: '{"path":"a.md"}',
      counters: { ...emptyCounters(), write: { lastWritePath: normalizePathKey('a.md'), samePathWriteStreak: 4 } },
    });
    const blocked = guards.evaluateBlocked(ctx);
    expect(blocked?.guardId).toBe('write_loop');
    expect(blocked?.message).toContain('[WRITE_LOOP_STOP]');
    // 换路径：streak 复位为 1 → 放行
    const reset = guards.evaluateBlocked(
      makeCtx({
        toolName: 'write_file',
        argsJson: '{"path":"b.md"}',
        counters: { ...emptyCounters(), write: { lastWritePath: normalizePathKey('a.md'), samePathWriteStreak: 4 } },
      }),
    );
    expect(reset).toBeUndefined();
  });

  it('read_failed：同主体连续失败达阈值拦', () => {
    const counters = emptyCounters();
    counters.readFailBySubject = new Map([
      [`read_file\u0002a.md\u0002\u0002`, 3],
    ]);
    const blocked = guards.evaluateBlocked(
      makeCtx({ toolName: 'read_file', argsJson: '{"path":"a.md"}', counters }),
    );
    expect(blocked?.guardId).toBe('read_failed');
  });

  it('read_failed 先于 read_dedup（同主体既失败达阈值又命中缓存 → 报失败闸）', () => {
    const counters = emptyCounters();
    const ctx = makeCtx({
      toolName: 'read_file',
      argsJson: '{"path":"a.md"}',
      counters,
    });
    counters.readFailBySubject = new Map([
      [`read_file\u0002a.md\u0002\u0002`, 3],
    ]);
    ctx.toolResultCache.set('read_file', readSubject('a.md'), 1);
    const blocked = guards.evaluateBlocked(ctx);
    expect(blocked?.guardId).toBe('read_failed');
  });

  it('read_dedup：缓存命中且仍在上下文才拦；不在上下文放行', () => {
    const c1 = makeCtx({ toolName: 'read_file', argsJson: '{"path":"a.md"}' });
    c1.toolResultCache.set('read_file', readSubject('a.md'), 2);
    const blocked = guards.evaluateBlocked(c1);
    expect(blocked?.guardId).toBe('read_dedup');
    expect(blocked?.message).toContain('[ALREADY_READ]');

    // 仍在上下文判定为 false → 内容已被压缩/裁剪 → 放行（CTX-1 防死锁）
    const c2 = makeCtx({
      toolName: 'read_file',
      argsJson: '{"path":"a.md"}',
      isCachedResultStillInContext: () => false,
    });
    c2.toolResultCache.set('read_file', readSubject('a.md'), 2);
    expect(guards.evaluateBlocked(c2)).toBeUndefined();
  });

  it('非 info 工具不触发 read 系判定', () => {
    const r = guards.evaluateBlocked(
      makeCtx({ toolName: 'run_code', argsJson: '{}', counters: { ...emptyCounters(), searchCallCount: 99 } }),
    );
    expect(r).toBeUndefined();
  });

  it('注册表顺序：默认注册序 read_failed 先于 read_dedup', () => {
    const ids = guards.guards.map((g) => g.id);
    expect(ids.indexOf('read_failed')).toBeLessThan(ids.indexOf('read_dedup'));
  });
});

describe('buildPromptSection 通用行为护栏节', () => {
  it('聚合各护栏通用声明（不含逐轮计数）', () => {
    const sec = registerAll(new GuardRail(), createDefaultGuardsShim()).buildPromptSection();
    expect(sec).toContain('## 行为护栏');
    // 描述性约束（不含运行时拒绝令牌：[TAG] 只在 renderPrompt 命中时产出，避免 system prompt 撞令牌定位）
    expect(sec).toContain('重复读取同一文件/搜索同一主体将被拦截并提示');
    expect(sec).toContain('同一文件被反复重写会触发写作死循环保护');
    expect(sec).toContain('每个问答闭环仅允许有限次提问');
    expect(sec).toContain('联网搜索达上限后视为信息已足');
    expect(sec).not.toContain('已执行 8 次');
    expect(sec).not.toContain('[ALREADY_READ]');
  });
});

// --- 私有 shim：复用 createDefaultGuards 的注册表，保注册序与生产一致 ---
function createDefaultGuardsShim() {
  // 直接从工厂取 guards（保注册顺序与判定顺序同源），不重复构造 def 字面量
  return createDefaultGuards().guards;
}
function registerAll(rail: GuardRail, defs: readonly GuardRailDef[]): GuardRail {
  for (const d of defs) rail.register(d);
  return rail;
}