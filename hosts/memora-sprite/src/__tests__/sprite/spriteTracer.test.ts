/**
 * SpriteTracer 单元测试
 *
 * 覆盖范围：
 * - SpriteTracer 构造 + startSpan：构造后可用 + dataDir 自动创建 + maxEntries 默认值 + 无 attributes + 独立 span
 * - SpriteSpan.setAttribute：单属性 + 覆盖 + 三种类型 + end 后不产生额外写入
 * - SpriteSpan.recordException：hasError 标记 + errorMessage 记录 + 默认 false + end 后不产生额外写入
 * - SpriteSpan.end 核心：JSONL 写入 + ISO 8601 时间 + durationMs 非负 + 防重复 + errorMessage 条件字段 + 顺序 end + 不阻塞
 * - JSONL 端到端：完整字段 + 串行写入 + maxEntries 截断 + attributes 序列化 + hasError 默认
 * - SPRITE_TRACE_SPANS 常量：3 个 span 命名 + TRACE_SPANS 重导出
 *
 * 测试策略（对齐 jsonlAppender.test.ts 的 tmpdir 真实 IO 模式）：
 * - 使用真实 tmpdir 验证端到端 JSONL 输出，零 mock
 * - JsonlAppender.append 是 fire-and-forget，appender 为 private 无法 flush
 * - 用 vi.waitFor 轮询文件状态，等待异步写入完成后再断言
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpriteTracer, SPRITE_TRACE_SPANS, TRACE_SPANS } from '../../sprite/spriteTracer.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 创建测试用临时目录 */
function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'memora-trace-test-'));
}

/** 读取 trace.log 并解析为 JSON 数组 */
function readTraceEntries(dir: string): Array<Record<string, unknown>> {
  const content = readFileSync(join(dir, 'trace.log'), 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 等待 trace.log 达到指定条数，返回解析后的数组 */
async function waitForTraceEntries(
  dir: string,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  return vi.waitFor(() => {
    const entries = readTraceEntries(dir);
    expect(entries).toHaveLength(count);
    return entries;
  });
}

/** ISO 8601 正则（如 2026-07-12T10:30:00.000Z） */
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('SpriteTracer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(async () => {
    // 等待 fire-and-forget 写入完成，避免删除目录时 pending 操作报错
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 构造 + startSpan（5 测试） ────────────────────────

  describe('构造 + startSpan', () => {
    it('构造后 startSpan 可用（返回含 ISpan 方法的对象）', () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('test.span');
      expect(span).toBeDefined();
      expect(typeof span.end).toBe('function');
      expect(typeof span.setAttribute).toBe('function');
      expect(typeof span.recordException).toBe('function');
    });

    it('dataDir 不存在时自动创建', () => {
      const nestedDir = join(tmpDir, 'nested', 'deep');
      expect(existsSync(nestedDir)).toBe(false);
      // 构造函数内部 JsonlAppender 会调用 mkdirSync recursive
      new SpriteTracer(nestedDir);
      expect(existsSync(nestedDir)).toBe(true);
    });

    it('maxEntries 默认值可用（不传 maxEntries 时正常工作）', async () => {
      const tracer = new SpriteTracer(tmpDir); // 不传 maxEntries
      const span = tracer.startSpan('default-test');
      span.end();
      // 能正常写入 1 条记录即说明默认值工作正常
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.name).toBe('default-test');
    });

    it('无 attributes 时使用空对象', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('no-attrs'); // 不传 attributes
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.attributes).toEqual({});
    });

    it('多次 startSpan 返回独立 span', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span1 = tracer.startSpan('span1', { id: 1 });
      const span2 = tracer.startSpan('span2', { id: 2 });
      expect(span1).not.toBe(span2);
      span1.end();
      span2.end();
      // 验证两个 span 独立写入各自的 attributes
      const entries = await waitForTraceEntries(tmpDir, 2);
      expect(entries[0]!.name).toBe('span1');
      expect(entries[0]!.attributes).toEqual({ id: 1 });
      expect(entries[1]!.name).toBe('span2');
      expect(entries[1]!.attributes).toEqual({ id: 2 });
    });
  });

  // ─── SpriteSpan.setAttribute（4 测试） ─────────────────

  describe('SpriteSpan.setAttribute', () => {
    it('设置单个属性', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('test');
      span.setAttribute('key', 'value');
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.attributes).toEqual({ key: 'value' });
    });

    it('覆盖已有属性', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('test', { key: 'old' });
      span.setAttribute('key', 'new');
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.attributes).toEqual({ key: 'new' });
    });

    it('支持 string/number/boolean 三种类型', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('types');
      span.setAttribute('str', 'hello');
      span.setAttribute('num', 42);
      span.setAttribute('bool', true);
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.attributes).toEqual({ str: 'hello', num: 42, bool: true });
    });

    it('end 后 setAttribute 不产生额外写入', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('test', { initial: 'value' });
      span.end();
      span.setAttribute('afterEnd', 'ignored');
      // end() 后 setAttribute 不会触发新的 append（end 有 ended 防重复守卫）
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries).toHaveLength(1);
    });
  });

  // ─── SpriteSpan.recordException（4 测试） ──────────────

  describe('SpriteSpan.recordException', () => {
    it('标记 hasError 为 true', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('error-span');
      span.recordException(new Error('boom'));
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.hasError).toBe(true);
    });

    it('记录 errorMessage', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('error-span');
      span.recordException(new Error('disk full'));
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.errorMessage).toBe('disk full');
    });

    it('未调用 recordException 时 hasError 为 false', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('ok-span');
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.hasError).toBe(false);
    });

    it('end 后 recordException 不产生额外写入', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('test');
      span.end();
      span.recordException(new Error('after-end'));
      // end() 后 recordException 不会触发新的 append
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries).toHaveLength(1);
    });
  });

  // ─── SpriteSpan.end 核心（8 测试） ─────────────────────

  describe('SpriteSpan.end 核心', () => {
    it('end 后 JSONL 写入 1 条记录', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('write-test');
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries).toHaveLength(1);
    });

    it('startedAt/endedAt 为 ISO 8601 格式', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('iso-test');
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.startedAt).toMatch(ISO_8601_REGEX);
      expect(entries[0]!.endedAt).toMatch(ISO_8601_REGEX);
    });

    it('durationMs 为非负数', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('duration-test');
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('重复 end 只写一次', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('dedup-test');
      span.end();
      span.end(); // 重复调用
      span.end(); // 第三次
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries).toHaveLength(1);
    });

    it('有 errorMessage 时含 errorMessage 字段', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('err-field-test');
      span.recordException(new Error('has message'));
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]).toHaveProperty('errorMessage', 'has message');
    });

    it('无 errorMessage 时不含该字段', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('no-err-field-test');
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]).not.toHaveProperty('errorMessage');
    });

    it('多个 span 顺序 end 保持写入顺序', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span1 = tracer.startSpan('first');
      const span2 = tracer.startSpan('second');
      const span3 = tracer.startSpan('third');
      span1.end();
      span2.end();
      span3.end();
      const entries = await waitForTraceEntries(tmpDir, 3);
      expect(entries[0]!.name).toBe('first');
      expect(entries[1]!.name).toBe('second');
      expect(entries[2]!.name).toBe('third');
    });

    it('end 不阻塞（返回 void，非 Promise）', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('non-blocking');
      const result = span.end();
      expect(result).toBeUndefined();
      // 等待 fire-and-forget 写入完成
      await waitForTraceEntries(tmpDir, 1);
    });
  });

  // ─── JSONL 端到端（5 测试） ───────────────────────────

  describe('JSONL 端到端', () => {
    it('单条 span 完整字段', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('full-entry', { model: 'gpt-4o' });
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      const entry = entries[0]!;
      // 验证所有核心字段存在且类型正确
      expect(entry.name).toBe('full-entry');
      expect(typeof entry.startedAt).toBe('string');
      expect(typeof entry.endedAt).toBe('string');
      expect(typeof entry.durationMs).toBe('number');
      expect(entry.attributes).toEqual({ model: 'gpt-4o' });
      expect(typeof entry.hasError).toBe('boolean');
    });

    it('多条 span 串行写入', async () => {
      const tracer = new SpriteTracer(tmpDir);
      for (let i = 1; i <= 5; i++) {
        const span = tracer.startSpan(`task.${i}`);
        span.end();
      }
      const entries = await waitForTraceEntries(tmpDir, 5);
      expect(entries).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(entries[i]!.name).toBe(`task.${i + 1}`);
      }
    });

    it('超出 maxEntries 时截断保留最近条目', async () => {
      // maxEntries=5，truncateCheckInterval 默认 100
      // 写入 100 条后触发截断检查，保留最近 5 条
      const tracer = new SpriteTracer(tmpDir, 5);
      for (let i = 1; i <= 100; i++) {
        const span = tracer.startSpan(`span.${i}`);
        span.end();
      }
      const entries = await waitForTraceEntries(tmpDir, 5);
      expect(entries).toHaveLength(5);
      // 保留最近 5 条（span.96 ~ span.100）
      expect(entries[0]!.name).toBe('span.96');
      expect(entries[4]!.name).toBe('span.100');
    });

    it('attributes 正确序列化（JSON round-trip）', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('serialize-test');
      span.setAttribute('stringVal', 'text');
      span.setAttribute('numberVal', 123);
      span.setAttribute('booleanVal', false);
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      // JSON round-trip 后类型应保持
      expect(entries[0]!.attributes).toEqual({
        stringVal: 'text',
        numberVal: 123,
        booleanVal: false,
      });
    });

    it('hasError 默认为 false', async () => {
      const tracer = new SpriteTracer(tmpDir);
      const span = tracer.startSpan('default-hasError');
      span.end();
      const entries = await waitForTraceEntries(tmpDir, 1);
      expect(entries[0]!.hasError).toBe(false);
    });
  });

  // ─── SPRITE_TRACE_SPANS 常量（2 测试） ─────────────────

  describe('SPRITE_TRACE_SPANS 常量', () => {
    it('包含 3 个 sprite 前缀的 span 命名', () => {
      expect(Object.keys(SPRITE_TRACE_SPANS)).toHaveLength(3);
      expect(SPRITE_TRACE_SPANS.WAKEUP).toBe('sprite.wakeup');
      expect(SPRITE_TRACE_SPANS.PROJECT_MODE).toBe('sprite.projectMode');
      expect(SPRITE_TRACE_SPANS.TRIGGER).toBe('sprite.trigger');
      // 所有值以 sprite. 前缀标识
      for (const value of Object.values(SPRITE_TRACE_SPANS)) {
        expect(value.startsWith('sprite.')).toBe(true);
      }
    });

    it('TRACE_SPANS 从 memora 内核重导出', () => {
      // 验证 spriteTracer.ts 重导出了内核的 TRACE_SPANS
      expect(TRACE_SPANS).toBeDefined();
      expect(typeof TRACE_SPANS).toBe('object');
    });
  });
});
