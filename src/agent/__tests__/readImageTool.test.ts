/**
 * read_image 出站合成链路测试
 *
 * 钉住两条**互不相同**的不变量（契约 `docs/architecture/image-tool-message-contract.md` §2.4）：
 *   1. `_prepareContext` 返回副本 —— 合成消息只在返回值里，`this.messages` 零改动；
 *   2. 合成消息不进 `this.messages`（Round / 落盘的唯一来源）—— 工具结果只有文本，
 *      图片只走 `ToolOutcome.attachments` 的结构化通道。
 *
 * 另钉暴露面（`resolveActiveTools` 按路由后 provider 的视觉位逐 step 裁剪）与
 * 路由隔离（`determineTaskType` 跳过合成消息）。
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import { determineTaskType } from '@/agent/managers/llmCaller.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { BUILTIN_TOOLS } from '@/agent/builtinTools.js';
import type { ToolDefinition } from '@/agent/builtinTools.js';
import { okOutcome } from '@/agent/managers/toolCallHelpers.js';
import type { ToolOutcome } from '@/agent/managers/toolCallHelpers.js';
import type { ChatOptions, ImageRef, LlmProvider, Message } from '@/llm/provider.js';

/**
 * 被测私有面取数口（仅测试用）：把 loop 断言成「只含本组用例需要的最小形状」，
 * 避免 `as any`（lint 禁 explicit-any，且无类型的 cast 看不出被测契约）。
 */
interface LoopInternals {
  /** 持久化来源（Round 唯一出口，getMessages 直接返回它） */
  messages: Message[];
  /** 本轮待挂出站视图的读图结果 */
  pendingImageReads: ImageRef[];
  /** 按能力位裁剪后的暴露面 */
  resolveActiveTools(): readonly ToolDefinition[];
  /** 出站视图装配（返回值即送信面；内部必须只读 this.messages） */
  _prepareContext(
    signal: AbortSignal | undefined,
  ): Promise<{ chatOpts: ChatOptions; safeMessages: readonly Message[] }>;
  /** 工具结果回填（tool 消息 + 图片附件分流） */
  _processToolResults(
    toolCalls: NonNullable<Message['toolCalls']>,
    results: readonly ToolOutcome[],
  ): void;
}

/** 取私有面（唯一 cast 点，收口在此） */
function internals(loop: AgentLoop): LoopInternals {
  return loop as unknown as LoopInternals;
}

/** 构造最小 Provider（只关心视觉能力位，chat 不会被本组用例调用） */
function makeProvider(supportsVision: boolean): LlmProvider {
  return {
    name: 'mock',
    supportsVision,
    async *chat() {
      yield { content: 'ok' };
    },
  } as unknown as LlmProvider;
}

/** read_image 的工具定义（从内置工具表取，保证测试与真实定义同源） */
const READ_IMAGE_DEF = BUILTIN_TOOLS.find((t) => t.name === 'read_image')!;

/** 构造一条图片引用（sha 由用例决定，用于去重断言） */
function makeRef(sha256: string, name = 'a.png'): ImageRef {
  return { sha256, mime: 'image/png', bytes: 68, width: 1, height: 1, name };
}

/** 构造工具调用参数（_processToolResults 只消费 id / function.name） */
function toolCall(id: string, name: string): NonNullable<Message['toolCalls']>[number] {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

describe('read_image · 路由隔离', () => {
  it('determineTaskType 跳过合成消息（超长合成消息不得把 simple 拉成 reasoning）', () => {
    const longContent = 'x'.repeat(LOOP_CONSTANTS.REASONING_INPUT_CHARS + 10);
    // 合成消息在窗口末位且超长：若参与判据，最后一条 user 内容会被判 reasoning
    const withSynthetic: Message[] = [
      { role: 'user', content: '你好' },
      { role: 'user', content: longContent, synthetic: true },
    ];
    expect(determineTaskType(withSynthetic)).toBe('simple');

    // 对照（证明断言有判据）：同一条消息去掉 synthetic 即 reasoning
    const withoutTag: Message[] = [{ role: 'user', content: longContent }];
    expect(determineTaskType(withoutTag)).toBe('reasoning');
  });
});

describe('read_image · 暴露面', () => {
  it('supportsVision=false → read_image 被 resolveActiveTools 裁掉；true → 暴露', () => {
    const toolDefinitions = [READ_IMAGE_DEF];
    const port = vi.fn();

    const blindLoop = new AgentLoop({
      provider: makeProvider(false),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      toolDefinitions,
      imageReadPort: port,
    });
    expect(
      internals(blindLoop)
        .resolveActiveTools()
        .map((t) => t.name),
    ).not.toContain('read_image');

    const visionLoop = new AgentLoop({
      provider: makeProvider(true),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      toolDefinitions,
      imageReadPort: port,
    });
    expect(
      internals(visionLoop)
        .resolveActiveTools()
        .map((t) => t.name),
    ).toContain('read_image');
  });

  it('提示词工具清单与逐 step 裁剪同源：视觉位热切换后两侧同步收敛', async () => {
    // 变异方向：删掉 _prepareContext 里的 syncToolListInSystemPrompt() ⇒ 切盲后
    // 「提示词仍写 read_image、下发已裁掉」⇒ 本例最终断言恰红。
    const provider = makeProvider(true) as LlmProvider & { supportsVision: boolean };
    const readFileDef = BUILTIN_TOOLS.find((t) => t.name === 'read_file')!;
    const loop = new AgentLoop({
      provider,
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      toolDefinitions: [readFileDef, READ_IMAGE_DEF],
      imageReadPort: async () => ({ ok: false, text: 'stub' }),
    });

    /** 提示词「## 可用工具」段列出的工具名（行格式与 buildSystemPrompt 同源） */
    const listedInPrompt = (): string[] => {
      const content = loop.getMessages()[0]?.content ?? '';
      return [...content.matchAll(/^ {2}- (\w+)/gm)].map((m) => m[1]!);
    };
    /** 实际下发清单的工具名（buildChatOptions 的 tools） */
    const sentToProvider = async (): Promise<string[]> => {
      const prep = await internals(loop)._prepareContext(undefined);
      return (prep.chatOpts.tools ?? []).map((t) => t.function.name);
    };

    // 视觉开：提示词与下发都含 read_image，且集合完全一致
    expect(listedInPrompt()).toContain('read_image');
    expect(new Set(await sentToProvider())).toEqual(new Set(listedInPrompt()));

    // 热切换到盲 provider：逐 step 裁剪立即生效，提示词必须同步重建（不能各说各话）
    provider.supportsVision = false;
    const sentAfter = await sentToProvider();
    expect(sentAfter).not.toContain('read_image');
    expect(listedInPrompt()).not.toContain('read_image');
    expect(new Set(sentAfter)).toEqual(new Set(listedInPrompt()));
  });
});

describe('read_image · 出站视图合成', () => {
  /** 构造带一条用户消息与读图端口的 loop（端口只做能力位：视觉开） */
  function makeLoop(): AgentLoop {
    return new AgentLoop({
      provider: makeProvider(true),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      toolDefinitions: [READ_IMAGE_DEF],
      imageReadPort: async () => ({ ok: false, text: 'stub' }),
    });
  }

  it('不变量 1：_prepareContext 返回副本，this.messages 不被追加（合成仅出站）', async () => {
    const loop = makeLoop();
    const messages: Message[] = [{ role: 'user', content: '看看这张图' }];
    const priv = internals(loop);
    priv.messages = messages;
    const ref = makeRef('sha-outbound');
    priv.pendingImageReads = [ref];

    const prep = await priv._prepareContext(undefined);

    // 副本语义：返回新数组、尾部一条合成 user 消息、原数组零改动
    expect(prep.safeMessages).not.toBe(messages);
    expect(prep.safeMessages.at(-1)?.synthetic).toBe(true);
    expect(prep.safeMessages.at(-1)?.role).toBe('user');
    expect(prep.safeMessages.at(-1)?.attachments).toEqual([ref]);
    // 持久化来源（getMessages 是「用于持久化」的唯一出口）与出站副本互不影响
    expect(loop.getMessages()).toBe(messages);
    expect(loop.getMessages()).toHaveLength(1);
    expect(loop.getMessages().some((m) => m.synthetic === true)).toBe(false);
  });

  it('不变量 2：合成消息不进 Round（getMessages）不落盘；工具结果只留文本 + 按 sha 去重', async () => {
    const loop = makeLoop();
    const priv = internals(loop);
    const baseline = loop.getMessages().length;

    // 同一 sha 的两次读图结果：pendingImageReads 只留一份
    priv._processToolResults(
      [toolCall('call-1', 'read_image'), toolCall('call-2', 'read_image')],
      [
        okOutcome('已读取图片 a.png', [makeRef('sha-dup', 'a.png')]),
        okOutcome('已读取图片 a-copy.png', [makeRef('sha-dup', 'a-copy.png')]),
      ],
    );

    // 出站合成确实发生了（下一条 _prepareContext 会挂图）
    const prep = await priv._prepareContext(undefined);
    expect(prep.safeMessages.at(-1)?.synthetic).toBe(true);

    // 重建是**替换** messages[0]（非追加），尾部插合成消息也不得改变 system 条数。
    // 注：本用例无技能注入 / 任务表强引导，基线恰为 1；全局**不恒为 1**——
    // _prepareContext 内的 executionTemp 注入（软上限/上下文压力/任务表/计划引导）
    // 与 injectSystemMessage 都会临时增加 system 条数，此处只钉「read_image 不新增」。
    expect(prep.safeMessages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(loop.getMessages().filter((m) => m.role === 'system')).toHaveLength(1);

    // 不变量 2：即使出站已合成，落盘来源（getMessages = Round 唯一来源）仍无合成标记/附件
    const persisted = loop.getMessages();
    expect(persisted).toHaveLength(baseline + 2);
    expect(persisted.every((m) => m.synthetic !== true)).toBe(true);
    expect(
      persisted.filter((m) => m.role === 'tool').every((m) => typeof m.content === 'string'),
    ).toBe(true);
    expect(persisted.every((m) => m.attachments === undefined)).toBe(true);

    // 去重：两次同 sha 只累积一张
    expect(priv.pendingImageReads).toHaveLength(1);
    expect(priv.pendingImageReads[0]?.sha256).toBe('sha-dup');
  });
});
