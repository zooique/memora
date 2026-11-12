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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { AgentLoop } from '@/agent/loop.js';
import { BuiltinToolHandlers } from '@/agent/builtinToolHandlers.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { ToolErrorCode } from '@/utils/errors.js';
import type { MemoraError } from '@/utils/errors.js';
import { determineTaskType } from '@/agent/managers/llmCaller.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import {
  BUILTIN_TOOLS,
  READ_IMAGE_MAX_BYTES_PER_CALL,
  READ_IMAGE_MAX_BYTES_PER_FILE,
  READ_IMAGE_MAX_PER_CALL,
  READ_IMAGE_MAX_PER_ROUND,
  READ_IMAGE_SUPPORTED_EXTENSIONS,
} from '@/agent/builtinTools.js';
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
  /** 工具派发的私有生成器（本组用例经它验证「裁掉后仍点名调用」的回喂文案） */
  executeToolCalls(
    toolCalls: NonNullable<Message['toolCalls']>,
    fullContent: string,
    signal: AbortSignal | undefined,
    stepIndex: number,
  ): AsyncGenerator<unknown, { aborted: boolean; outcomes: ToolOutcome[] }, unknown>;
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

describe('read_image · 工具描述', () => {
  it('描述写明目录模式与全部限额，格式清单与实现同源（模型据此决定调不调）', () => {
    const desc = READ_IMAGE_DEF.description;
    expect(desc).toContain('目录');
    // 格式清单唯一真源：描述里的每个扩展名都来自 READ_IMAGE_SUPPORTED_EXTENSIONS
    for (const ext of READ_IMAGE_SUPPORTED_EXTENSIONS) expect(desc).toContain(ext);
    expect(desc).toContain(`单次 ≤ ${READ_IMAGE_MAX_PER_CALL} 张`);
    expect(desc).toContain(`单张 ≤ ${READ_IMAGE_MAX_BYTES_PER_FILE / 1024 / 1024} MiB`);
    expect(desc).toContain(`同一轮附图最多 ${READ_IMAGE_MAX_PER_ROUND} 张`);
    expect(desc).toContain(`${READ_IMAGE_MAX_BYTES_PER_CALL / 1024 / 1024} MiB`);
    // 超限行为必须写明「不会只附前几张」
    expect(desc).toContain('不会只附前几张');
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

describe('read_image · 两种「不可用」原因分开说', () => {
  /**
   * 驱动一次工具派发并取回结构化 outcomes（私有生成器的测试薄壳）
   *
   * 为什么直接驱动私有生成器：本组要验证的正是「暴露面裁掉后模型仍点名调用」时的
   * **执行前回喂**，而不是 handler 内部文案——绕开 loop 就测不到那条守卫。
   */
  async function runToolDispatch(loop: AgentLoop, name: string): Promise<ToolOutcome[]> {
    const gen = internals(loop).executeToolCalls([toolCall('call-img', name)], '', undefined, 1);
    let step: IteratorResult<unknown, { aborted: boolean; outcomes: ToolOutcome[] }>;
    do {
      step = await gen.next();
    } while (!step.done);
    return step.value.outcomes;
  }

  it('宿主未注入读图端口 → 指明「当前宿主不支持读图」（MCP 宿主），且不是文件问题', async () => {
    const loop = new AgentLoop({
      provider: makeProvider(true),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      toolDefinitions: [READ_IMAGE_DEF],
      // 刻意不传 imageReadPort（= 非 VS Code 宿主，如 MCP 宿主）
    });

    const outcomes = await runToolDispatch(loop, 'read_image');

    expect(outcomes).toHaveLength(1);
    // 主动挡下（能力缺失不是「执行了一次没成功」）
    expect(outcomes[0]!.status).toBe('blocked');
    expect(outcomes[0]!.blockedReason).toBe('not_exposed');
    expect(outcomes[0]!.text).toContain('当前运行环境不支持读图');
    expect(outcomes[0]!.text).toContain('MCP');
    expect(outcomes[0]!.text).toContain('不是文件问题');
    // 两种原因不得互相污染
    expect(outcomes[0]!.text).not.toContain('当前模型未声明支持图片输入');
  });

  it('provider 未声明视觉 → 指明「当前模型未声明支持图片输入」+ provider 配置项，且不是文件问题', async () => {
    const executor = vi.fn(async () => '不该被调用');
    const port = vi.fn(async () => ({ ok: false as const, text: '不该被调用' }));
    const loop = new AgentLoop({
      provider: makeProvider(false),
      bootstrapMemories: [],
      toolExecutor: executor,
      toolDefinitions: [READ_IMAGE_DEF],
      imageReadPort: port,
    });

    const outcomes = await runToolDispatch(loop, 'read_image');

    expect(outcomes[0]!.status).toBe('blocked');
    expect(outcomes[0]!.text).toContain('当前模型未声明支持图片输入');
    expect(outcomes[0]!.text).toContain('supportsVision');
    expect(outcomes[0]!.text).toContain('不是文件问题');
    // 指到具体设置位置（不只说「未开启」）：命令 + 勾选项，用户知道去哪开
    expect(outcomes[0]!.text).toContain('Memora: 配置大模型');
    expect(outcomes[0]!.text).toContain('支持图片输入');
    expect(outcomes[0]!.text).not.toContain('当前运行环境不支持读图');
    // 执行前拦截：宿主端口与 executor 都未被触碰（不制造「读了文件才发现不行」的假象）
    expect(port).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });
});

describe('read_image · handler 侧原因文案（绕过 loop 直调执行器时）', () => {
  /** 临时项目根（每个 it 重建：handler 需要真实路径通过 guard 与目录预检） */
  let projectPath: string;
  /** 被测 handler（未注入端口 / 注入替身由各用例决定） */
  let handlers: BuiltinToolHandlers;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'memora-read-image-'));
    handlers = new BuiltinToolHandlers(
      projectPath,
      new SecurityGuard(projectPath, projectPath),
      new InMemoryStorage(),
    );
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('宿主未注入读图端口 → 明确「当前宿主不支持读图」（MCP 宿主举例）+「不是文件问题」', async () => {
    // 先让目标路径通过「存在且不是目录」预检（端口检查在其后）
    await writeFile(join(projectPath, 'pic.png'), 'not-a-real-png');
    let err: MemoraError | undefined;
    try {
      await handlers.readImage('pic.png');
      expect.unreachable('未注入端口时必须抛 NOT_AVAILABLE');
    } catch (e) {
      err = e as MemoraError;
    }
    const visible = `${err.title} ${err.detail} ${err.suggestions.join(' ')}`;
    expect(err.errorCode).toBe(ToolErrorCode.NOT_AVAILABLE);
    expect(visible).toContain('运行环境不支持读图');
    expect(visible).toContain('MCP');
    expect(visible).toContain('不是文件问题');
  });

  it('端口回绝（如视觉位第二层拒绝）→ 原样透传宿主原因，不擅自归因成文件问题', async () => {
    await writeFile(join(projectPath, 'pic2.png'), 'not-a-real-png');
    const hostReason = 'read_image 已取消：当前模型未声明支持视觉输入（supportsVision=false）。';
    handlers.setImageReadPort(async () => ({ ok: false, text: hostReason }));
    let err: MemoraError | undefined;
    try {
      await handlers.readImage('pic2.png');
      expect.unreachable('端口回绝时必须抛 NOT_AVAILABLE');
    } catch (e) {
      err = e as MemoraError;
    }
    // detail 原样携带宿主自述原因（含 provider 配置项名），供模型/用户自行分辨
    expect(err.detail).toBe(hostReason);
    expect(err.suggestions.join(' ')).toContain('supportsVision');
    expect(err.errorCode).toBe(ToolErrorCode.NOT_AVAILABLE);
  });

  // ── 目录模式（端口契约保持单张，目录枚举在 handler 内逐张调端口） ──

  it('目录模式：多图按文件名排序返回，不递归子目录、不误读非图片', async () => {
    const dir = join(projectPath, 'shots');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'b.png'), 'b');
    await writeFile(join(dir, 'a.jpg'), 'a');
    await writeFile(join(dir, 'c.webp'), 'c');
    await writeFile(join(dir, 'notes.txt'), 'skip');
    await writeFile(join(dir, 'nested', 'd.png'), 'nested');
    handlers.setImageReadPort(async (abs) => ({
      ok: true,
      ref: makeRef(`sha-${basename(abs)}`, basename(abs)),
    }));

    const read = await handlers.readImage('shots');

    // 排序 = 文件名（a < b < c）；非图片与子目录内容都不进结果
    expect(read.refs.map((r) => r.name)).toEqual(['a.jpg', 'b.png', 'c.webp']);
    expect(read.text).toContain('已读取目录 shots 下的 3 张图片（按文件名排序）');
    expect(read.text).not.toContain('notes.txt');
    expect(read.text).not.toContain('d.png');
  });

  it(`目录超过单次 ${READ_IMAGE_MAX_PER_CALL} 张 → 报错并列出候选，不静默只附前几张`, async () => {
    const dir = join(projectPath, 'many');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, `img-${String(i).padStart(2, '0')}.png`), 'x');
    }
    /** 端口替身：本用例必须零调用（证明没有「先附前 8 张」的行为） */
    const port = vi.fn();
    handlers.setImageReadPort(port);

    let err: MemoraError | undefined;
    try {
      await handlers.readImage('many');
      expect.unreachable(`超过 ${READ_IMAGE_MAX_PER_CALL} 张必须报错`);
    } catch (e) {
      err = e as MemoraError;
    }
    expect(err.errorCode).toBe(ToolErrorCode.ARGUMENT_ERROR);
    expect(err.detail).toContain('共 10 张受支持的图片');
    expect(err.detail).toContain(`超过单次 ${READ_IMAGE_MAX_PER_CALL} 张上限`);
    // 候选清单齐全（首个与末个都在），不是只给前 8 个
    expect(err.detail).toContain('img-00.png');
    expect(err.detail).toContain('img-09.png');
    expect(port).not.toHaveBeenCalled();
  });

  it('目录内没有受支持的图片 / 空目录 → 报错且不调用端口', async () => {
    await mkdir(join(projectPath, 'only-text'), { recursive: true });
    await mkdir(join(projectPath, 'empty'), { recursive: true });
    await writeFile(join(projectPath, 'only-text', 'readme.md'), '# hi');
    const port = vi.fn();
    handlers.setImageReadPort(port);

    for (const dirName of ['only-text', 'empty']) {
      let err: MemoraError | undefined;
      try {
        await handlers.readImage(dirName);
        expect.unreachable('目录内没有图片必须报错');
      } catch (e) {
        err = e as MemoraError;
      }
      expect(err.title).toContain('目录内没有图片');
      expect(err.errorCode).toBe(ToolErrorCode.FILE_NOT_FOUND);
    }
    expect(port).not.toHaveBeenCalled();
  });

  it('目录不存在 → FILE_NOT_FOUND「路径不存在」，不误报成读图不可用', async () => {
    handlers.setImageReadPort(async () => ({ ok: false, text: 'stub' }));
    let err: MemoraError | undefined;
    try {
      await handlers.readImage('no-such-dir');
      expect.unreachable('路径不存在必须报错');
    } catch (e) {
      err = e as MemoraError;
    }
    expect(err.errorCode).toBe(ToolErrorCode.FILE_NOT_FOUND);
    expect(err.detail).toContain('不存在');
  });

  it('目录越界 → PATH_NOT_ALLOWED（目录模式不绕过路径校验）', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'memora-outside-'));
    try {
      await writeFile(join(outside, 'x.png'), 'x');
      handlers.setImageReadPort(async () => ({ ok: true, ref: makeRef('sha-x', 'x.png') }));
      let err: MemoraError | undefined;
      try {
        // 绝对路径且在项目根之外：守卫必须硬拒
        await handlers.readImage(outside);
        expect.unreachable('越界路径必须拒绝');
      } catch (e) {
        err = e as MemoraError;
      }
      expect(err.errorCode).toBe(ToolErrorCode.PATH_NOT_ALLOWED);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it(`单次图片总字节超过 ${READ_IMAGE_MAX_BYTES_PER_CALL / 1024 / 1024} MiB → 报错并写明当前总量，不读盘`, async () => {
    const dir = join(projectPath, 'big');
    await mkdir(dir, { recursive: true });
    // 5 个「4 MiB + 1」的文件：合计略超单次总量上限，张数仍在上限内
    const chunk = Buffer.alloc(4 * 1024 * 1024 + 1);
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `big-${i}.png`), chunk);
    const port = vi.fn();
    handlers.setImageReadPort(port);

    let err: MemoraError | undefined;
    try {
      await handlers.readImage('big');
      expect.unreachable('总量超限必须报错');
    } catch (e) {
      err = e as MemoraError;
    }
    expect(err.errorCode).toBe(ToolErrorCode.ARGUMENT_ERROR);
    expect(err.detail).toContain('合计 20.0 MiB');
    expect(err.detail).toContain(
      `超过单次 ${(READ_IMAGE_MAX_BYTES_PER_CALL / 1024 / 1024).toFixed(1)} MiB 上限`,
    );
    // stat 预筛：超限时一张都不读进内存
    expect(port).not.toHaveBeenCalled();
  });

  it('目录里坏 1 张不影响其余：成功附上的图与失败原因都写明', async () => {
    const dir = join(projectPath, 'mixed');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bad.png'), 'bad');
    await writeFile(join(dir, 'good.png'), 'good');
    handlers.setImageReadPort(async (abs) =>
      basename(abs) === 'bad.png'
        ? { ok: false, text: '不是有效图片' }
        : { ok: true, ref: makeRef(`sha-${basename(abs)}`, basename(abs)) },
    );

    const read = await handlers.readImage('mixed');

    expect(read.refs.map((r) => r.name)).toEqual(['good.png']);
    expect(read.text).toContain('未附上的 1 张');
    expect(read.text).toContain('bad.png：不是有效图片');
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

    // 去重结论必须写进 tool 结果文本：否则用户/模型数不明白「为什么只看到 1 张」
    const toolTexts = persisted.filter((m) => m.role === 'tool').map((m) => m.content as string);
    expect(toolTexts[0]).not.toContain('【附件去重】');
    expect(toolTexts[1]).toContain('本次 1 张中有 1 张与本轮已有图片重复，已略过');
  });

  it('同一轮附图总数上限 12：超出的图明确告知留待下一轮（不静默丢弃）', () => {
    const loop = makeLoop();
    const priv = internals(loop);
    /** 比上限多 1 张 */
    const refs = Array.from({ length: READ_IMAGE_MAX_PER_ROUND + 1 }, (_, i) =>
      makeRef(`sha-cap-${i}`, `img-${i}.png`),
    );

    priv._processToolResults(
      [toolCall('call-cap', 'read_image')],
      [okOutcome(`已读取 ${refs.length} 张图片`, refs)],
    );

    // 队列只收上限内数量；工具结果文字明确「剩余 N 张未附」
    expect(priv.pendingImageReads).toHaveLength(READ_IMAGE_MAX_PER_ROUND);
    const toolMsg = loop
      .getMessages()
      .filter((m) => m.role === 'tool')
      .at(-1);
    expect(toolMsg?.content).toContain(`本轮附图已达 ${READ_IMAGE_MAX_PER_ROUND} 张`);
    // 必须点名到具体文件：只说「剩余 1 张」模型不知道下一轮该重读哪张
    expect(toolMsg?.content).toContain('剩余 1 张未附：img-12.png');
  });
});

describe('read_image · 与宿主契约对齐（两个包没有共享编译单元，只能靠测试约束）', () => {
  /**
   * 读取宿主共享校验模块源码（上限与格式的第二份真源不在内核，
   * 内核 rootDir=src 不能 import 宿主源码，故读源码文本做契约断言）
   */
  function readHostImageValidationSource(): string {
    return readFileSync(
      join(process.cwd(), 'hosts', 'memora-vscode', 'src', 'shared', 'imageValidation.ts'),
      'utf8',
    );
  }

  it('内核 READ_IMAGE_MAX_BYTES_PER_FILE === 宿主 MAX_IMAGE_BYTES', () => {
    // 任一侧改了数值而另一侧没跟，这里会红（字面量表达式按乘法求值，不 eval）
    const matched = /export const MAX_IMAGE_BYTES\s*=\s*([\d\s*_]+);/.exec(
      readHostImageValidationSource(),
    );
    expect(matched).not.toBeNull();
    /** 宿主字面量（形如 `5 * 1024 * 1024`）按乘法求值 */
    const hostBytes = matched![1]!
      .split('*')
      .reduce((product, term) => product * Number(term.replace(/_/g, '').trim()), 1);

    expect(hostBytes).toBeGreaterThan(0);
    expect(READ_IMAGE_MAX_BYTES_PER_FILE).toBe(hostBytes);
  });

  it('内核扩展名清单与宿主 SUPPORTED_IMAGE_MIMES 覆盖同一批格式', () => {
    const matched = /export const SUPPORTED_IMAGE_MIMES = \[([\s\S]*?)\];/.exec(
      readHostImageValidationSource(),
    );
    expect(matched).not.toBeNull();
    /** 宿主支持的 mime 清单（按源码里的声明顺序） */
    const hostMimes = [...matched![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    /** 内核扩展名 → 宿主 mime（同一格式的别名映射到同一 mime） */
    const extensionMime: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    };
    for (const ext of READ_IMAGE_SUPPORTED_EXTENSIONS) {
      expect(extensionMime[ext]).toBeDefined();
    }
    /** 内核清单映射后的 mime 去重集合 */
    const kernelMimes = new Set(READ_IMAGE_SUPPORTED_EXTENSIONS.map((ext) => extensionMime[ext]!));

    expect(kernelMimes).toEqual(new Set(hostMimes));
  });
});
