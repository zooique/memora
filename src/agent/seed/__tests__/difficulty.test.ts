/**
 * 难度分级独立单元测试
 *
 * 覆盖 DifficultyJudge.classify：
 *   - 后台不可用（null）→ unknown（不阻断主回答）
 *   - 判词复杂 → complex / 简单 → simple（改大小写 + 模糊包含）
 *   - 无法解析（空 / 非空乱码）→ unknown（判不了即不入外部任务循环，可逆降级优先）
 *   - 后台 LLM 异常 → 降级 unknown（不抛）
 */

import { describe, it, expect } from 'vitest';
import { DifficultyJudge } from '@/agent/seed/difficulty.js';
import { mockProvider } from './harness.js';

const NULL_TRACER = null;

describe('DifficultyJudge 难度分级', () => {
  it('后台不可用 → unknown（跳过汇报，不阻断）', async () => {
    const judge = new DifficultyJudge(() => null, NULL_TRACER);
    await expect(judge.classify('任意输入')).resolves.toBe('unknown');
  });

  it('判词 complex → complex（改大小写 + 模糊包含）', async () => {
    const judge = new DifficultyJudge(() => mockProvider('COMPLEX'), NULL_TRACER);
    await expect(judge.classify('帮我重构模块')).resolves.toBe('complex');
  });

  it('判词 simple → simple', async () => {
    const judge = new DifficultyJudge(() => mockProvider('simple'), NULL_TRACER);
    await expect(judge.classify('今天天气')).resolves.toBe('simple');
  });

  it('判词含 simple 文本 → simple（容忍多余输出）', async () => {
    const judge = new DifficultyJudge(() => mockProvider('simple。'), NULL_TRACER);
    await expect(judge.classify('你好')).resolves.toBe('simple');
  });

  it('空响应 → unknown（无法判定）', async () => {
    const judge = new DifficultyJudge(() => mockProvider('  \n'), NULL_TRACER);
    await expect(judge.classify('输入')).resolves.toBe('unknown');
  });

  it('非空但无法识别 → unknown（判不了即不触发外部任务循环，可逆降级优先）', async () => {
    const judge = new DifficultyJudge(() => mockProvider('无法判断的乱码'), NULL_TRACER);
    await expect(judge.classify('输入')).resolves.toBe('unknown');
  });

  it('后台 LLM 抛异常 → 降级 unknown，不向上抛', async () => {
    const judge = new DifficultyJudge(
      () => ({
        name: 'mock-fail',
        supportedModels: [],
        async *chat() {
          throw new Error('LLM 不可用');
        },
      }) as never,
      NULL_TRACER,
    );
    await expect(judge.classify('输入')).resolves.toBe('unknown');
  });
});