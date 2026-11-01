/**
 * 后台 Provider 解析 + 失败升级测试（P2 窄版 · `BG-ESCALATE-1`）
 *
 * 覆盖范围：
 *   - 未配置后台 Provider → 原样返回前台（零包装）
 *   - 后台正常 → 前台零调用（升级不误触发）
 *   - 后台「未产出增量即失败」→ 前台重试一次，产出前台内容
 *   - 后台「已产出增量后失败」→ 直接抛出，不重试（防重复正文）
 *   - 用户取消（signal.aborted）→ 不重试
 *   - 能力位镜像 primary（装饰器不改变能力语义）
 */
import { describe, it, expect } from 'vitest';
import { LlmProvider } from '@/llm/provider.js';
import type { ChatOptions, Message } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import { resolveBackgroundProvider } from '@/llm/backgroundProvider.js';

/** 测试用 Provider：按 behavior 模拟「正常 / 产出前失败 / 产出后失败」 */
class FakeProvider extends LlmProvider {
  /** 上报名（断言包装器 name 拼接用） */
  readonly name: string;
  /** 被调用次数（断言「前台零调用」用） */
  calls = 0;
  /** 行为模式：ok = 正常产出；failBefore = 进入即抛；failAfter = 先产一块再抛 */
  private readonly behavior: 'ok' | 'failBefore' | 'failAfter';
  /** 产出内容 */
  private readonly text: string;

  constructor(name: string, behavior: 'ok' | 'failBefore' | 'failAfter' = 'ok', text = 'ok') {
    super();
    this.name = name;
    this.behavior = behavior;
    this.text = text;
  }

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    this.calls += 1;
    if (this.behavior === 'failBefore') {
      throw new Error(`${this.name} 失败`);
    }
    if (this.behavior === 'failAfter') {
      yield { content: `${this.text}-部分` };
      throw new Error(`${this.name} 中途失败`);
    }
    yield { content: this.text, finishReason: 'stop' };
  }
}

/** 收集流式增量文本（便于断言最终产出） */
async function collect(provider: LlmProvider, opts?: ChatOptions): Promise<string> {
  let out = '';
  for await (const chunk of provider.chat([{ role: 'user', content: 'q' }], opts)) {
    out += chunk.content ?? '';
  }
  return out;
}

describe('resolveBackgroundProvider · 解析与升级', () => {
  it('未配置后台 Provider 时原样返回前台实例（零包装）', () => {
    const foreground = new FakeProvider('fg');
    const resolved = resolveBackgroundProvider(null, foreground);
    // 同一实例：不包装饰器 ⇒ 不存在「多一层无意义调用」
    expect(resolved).toBe(foreground);
  });

  it('后台 Provider 正常时前台零调用（升级不误触发）', async () => {
    const background = new FakeProvider('bg', 'ok', 'bg-ok');
    const foreground = new FakeProvider('fg', 'ok', 'fg-ok');
    const resolved = resolveBackgroundProvider(background, foreground);

    expect(await collect(resolved)).toBe('bg-ok');
    expect(background.calls).toBe(1);
    expect(foreground.calls).toBe(0);
  });

  it('后台未产出增量即失败时升级到前台重试一次', async () => {
    const background = new FakeProvider('bg', 'failBefore');
    const foreground = new FakeProvider('fg', 'ok', 'fg-ok');
    const resolved = resolveBackgroundProvider(background, foreground);

    expect(await collect(resolved)).toBe('fg-ok');
    expect(background.calls).toBe(1);
    expect(foreground.calls).toBe(1);
  });

  it('后台已产出增量后失败时不重试（防重复正文），异常如实抛出', async () => {
    const background = new FakeProvider('bg', 'failAfter', 'bg');
    const foreground = new FakeProvider('fg', 'ok', 'fg-ok');
    const resolved = resolveBackgroundProvider(background, foreground);

    await expect(collect(resolved)).rejects.toThrow('中途失败');
    expect(foreground.calls).toBe(0);
  });

  it('用户已取消（signal.aborted）时不重试', async () => {
    const background = new FakeProvider('bg', 'failBefore');
    const foreground = new FakeProvider('fg', 'ok', 'fg-ok');
    const resolved = resolveBackgroundProvider(background, foreground);
    const controller = new AbortController();
    controller.abort();

    await expect(collect(resolved, { signal: controller.signal })).rejects.toThrow('bg 失败');
    expect(foreground.calls).toBe(0);
  });

  it('能力位镜像 primary（装饰器不改变能力语义）', () => {
    // 后台为「无原生工具调用」的本地模型：包装后该能力位仍须为 false（否则调用方判据被谎报）
    class NoToolProvider extends LlmProvider {
      readonly name = 'no-tool';
      override readonly supportsToolCalling = false;
      async *chat(): AsyncIterable<LlmChunk> {
        yield { content: 'ok' };
      }
    }
    const background = new NoToolProvider();
    const foreground = new FakeProvider('fg');
    const resolved = resolveBackgroundProvider(background, foreground);

    expect(resolved.supportsToolCalling).toBe(false);
    expect(resolved.supportsVision).toBe(background.supportsVision);
    // 上报名标明这是升级包装器（日志/遥测一眼可辨）
    expect(resolved.name).toBe('no-tool(→fg)');
  });
});
