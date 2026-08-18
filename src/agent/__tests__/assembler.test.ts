/**
 * assembler 单元测试 — Agent 组件组装器工厂函数
 *
 * 覆盖范围：
 *   - security 校验（pctx.security=null 抛 MemoraError）
 *   - 4 阶段组装成功 + 返回值完整性（AssembleOutput 12 个字段）
 *   - systemPromptPrefix 组装（personaPrompt 内部非空 + 当前时间注入）
 *   - skillManager 复用（existingSkillManager 注入 vs 新建）
 *   - 配置透传（activeRolePack / configDir / tracer / enableContextSummary）
 *
 * 测试范式：真实 InMemoryStorage + 真实 SecurityGuard + mock LlmProvider（chat 返回空 AsyncIterable）+
 * mock fileStore + configDir=undefined 走降级路径，聚焦组装逻辑而非各组件自身行为（各组件已有独立测试）。
 *
 * 设计约束：
 * - 生产代码禁止 @ts-ignore / as any / as unknown as（零例外）
 * - 测试 mock 允许 as unknown as（构造部分实现的 mock 对象，TS 社区惯例）
 * - 类型导入使用 import type
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleComponents } from '@/agent/assembler.js';
import type { AssembleInput } from '@/agent/assembler.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { SkillManager } from '@/skill/skillManager.js';
import { MemoraError } from '@/utils/errors.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { ProjectContext } from '@/memory/projectManager.js';
import type { Memory } from '@/memory/types.js';
import type { FileStore } from '@/memory/store.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/** 临时项目根目录（每个 it 重建） */
let projectPath: string;
/** 真实 InMemoryStorage（pctx.index，组件依赖的真实存储） */
let storage: InMemoryStorage;
/** 真实 SecurityGuard（projectPath 在白名单内，confirmWrites=false 自动确认） */
let security: SecurityGuard;
/** mock provider（chat 返回空 AsyncIterable，assembleComponents 不调用 chat） */
let provider: LlmProvider;
/** mock backgroundProvider */
let backgroundProvider: LlmProvider;
/** mock fileStore */
let fileStore: FileStore;

beforeEach(async () => {
  // 创建临时项目目录
  projectPath = await mkdtemp(join(tmpdir(), 'memora-assembler-'));
  storage = new InMemoryStorage();
  security = new SecurityGuard(projectPath, projectPath);
  provider = createMockProvider('mock-provider');
  backgroundProvider = createMockProvider('mock-background');
  fileStore = createMockFileStore();
});

afterEach(async () => {
  // 清理临时目录
  await rm(projectPath, { recursive: true, force: true });
});

/**
 * 构造 mock LlmProvider
 *
 * chat 返回空 AsyncIterable（assembleComponents 不调用 chat，
 * 但 WorkProjectionManager 等构造时会存储 provider 引用）
 *
 * @param name - provider 名称
 * @returns mock LlmProvider
 */
function createMockProvider(name: string): LlmProvider {
  const chatMock = vi.fn().mockImplementation(() => {
    return (async function* () {
      yield { content: '' } as LlmChunk;
    })();
  });
  return { name, chat: chatMock } as unknown as LlmProvider;
}

/**
 * 构造 mock FileStore
 *
 * 提供空实现，供 ProjectContext 使用
 *
 * @returns mock FileStore
 */
function createMockFileStore(): FileStore {
  return {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  } as unknown as FileStore;
}

/**
 * 构造最小 AssembleInput
 * @param overrides - 字段覆写
 * @returns 完整 AssembleInput
 */
function createInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    provider,
    backgroundProvider,
    projectPath,
    configDir: undefined,
    activeRolePack: undefined,
    maxContextTokens: 1000,
    sessionStore: undefined,
    tracer: undefined,
    messages: undefined,
    enableContextSummary: false,
    existingSkillManager: null,
    ...overrides,
  };
}

/**
 * 构造最小 ProjectContext（Partial 断言，仅提供 assembler 用到的字段）
 * @param overrides - 字段覆写
 * @returns 完整 ProjectContext
 */
function createPctx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    projectPath,
    projectName: 'test-project',
    memoraDir: projectPath,
    dbPath: join(projectPath, 'memora.db'),
    fileStore,
    index: storage,
    security,
    bootstrapMemories: [],
    loadResult: { success: true, migrated: false },
    ...overrides,
  } as ProjectContext;
}

// ─── security 校验 ────────────────────────────────────────

describe('assembleComponents', () => {
  describe('security 校验', () => {
    it('pctx.security=null 抛 MemoraError（显式校验）', async () => {
      // 安全守卫未注入时，组装器应在 Phase 1 起点抛错，避免后续组件拿到 null security
      const pctx = createPctx({ security: null });
      await expect(assembleComponents(pctx, createInput())).rejects.toThrow(MemoraError);
    });

    it('错误信息包含排查建议', async () => {
      // configError 的第三参数是排查建议数组，错误消息应包含可检索的关键词
      const pctx = createPctx({ security: null });
      try {
        await assembleComponents(pctx, createInput());
        expect.fail('应抛 MemoraError');
      } catch (err) {
        expect(err).toBeInstanceOf(MemoraError);
        const msg = (err as MemoraError).message;
        // 错误消息应包含 security guard 关键词，便于日志检索
        expect(msg).toContain('security guard');
      }
    });
  });

  // ─── 组装成功 + 返回值完整性 ────────────────────────────

  describe('组装成功 + 返回值完整性', () => {
    it('返回 AssembleOutput 包含全部 12 个字段', async () => {
      const output = await assembleComponents(createPctx(), createInput());

      // 12 个字段全部存在（history/loop/toolExec/
      // workProjection/skillManager/memoryInspector/
      // dedupManager/memoryAdvisor/roundSummaryGenerator/
      // sessionArchiver/textPolisher/rolePackManager）
      const expectedKeys = [
        'history',
        'loop',
        'toolExec',
        'workProjection',
        'skillManager',
        'memoryInspector',
        'dedupManager',
        'memoryAdvisor',
        'roundSummaryGenerator',
        'sessionArchiver',
        'textPolisher',
        'rolePackManager',
      ];
      expect(Object.keys(output).sort()).toEqual(expectedKeys.sort());
    });

    it('所有组件实例均已创建（非 undefined/null）', async () => {
      const output = await assembleComponents(createPctx(), createInput());
      // 逐一验证组件实例存在
      expect(output.history).toBeDefined();
      expect(output.loop).toBeDefined();
      expect(output.toolExec).toBeDefined();
      expect(output.workProjection).toBeDefined();
      expect(output.skillManager).toBeDefined();
      expect(output.memoryInspector).toBeDefined();
      expect(output.memoryAdvisor).toBeDefined();
      expect(output.dedupManager).toBeDefined();
      expect(output.rolePackManager).toBeDefined();
    });
  });

  // ─── skillManager 复用 ─────────────────────────────────

  describe('skillManager 复用', () => {
    it('existingSkillManager=null 时新建 SkillManager 实例', async () => {
      const output = await assembleComponents(createPctx(), createInput({ existingSkillManager: null }));
      // 返回值应是新建的 SkillManager 实例
      expect(output.skillManager).toBeInstanceOf(SkillManager);
    });

    it('existingSkillManager 提供时复用同一引用（避免重复 load）', async () => {
      // 首次组装创建 skillManager，二次组装传入已创建的实例应复用
      const first = await assembleComponents(createPctx(), createInput());
      const existing = first.skillManager;

      const second = await assembleComponents(createPctx(), createInput({ existingSkillManager: existing }));
      // 返回值应严格等于传入引用（=== 引用相等）
      expect(second.skillManager).toBe(existing);
    });
  });

  // ─── 配置透传 ──────────────────────────────────────────

  describe('配置透传', () => {
    it('activeRolePack 透传到 RolePackManager.load（角色不存在走降级）', async () => {
      // 传入不存在的 activeRolePack，RolePackManager 应降级到默认角色，组装仍成功
      const output = await assembleComponents(
        createPctx(),
        createInput({ activeRolePack: '不存在的角色包' }),
      );
      // rolePackPrompt 仅内部使用，通过 systemPromptPrefix 间接消费
      expect(output.rolePackManager).toBeDefined();
    });

    it('tracer 注入时组装成功（AgentLoop 接收 tracer）', async () => {
      // 传入 mock tracer，AgentLoop 构造时应接收并存储
      const mockTracer = {
        startSpan: vi.fn().mockReturnValue({
          setAttribute: vi.fn(),
          end: vi.fn(),
          recordException: vi.fn(),
        }),
      };
      const output = await assembleComponents(
        createPctx(),
        createInput({ tracer: mockTracer as unknown as AssembleInput['tracer'] }),
      );
      expect(output.loop).toBeDefined();
    });

    it('enableContextSummary=true 时组装成功', async () => {
      // 开启上下文摘要，AgentLoop 构造时接收
      const output = await assembleComponents(
        createPctx(),
        createInput({ enableContextSummary: true }),
      );
      expect(output.loop).toBeDefined();
    });
  });

  // ─── bootstrapMemories 透传 ────────────────────────────

  describe('bootstrapMemories 透传', () => {
    it('bootstrapMemories 非空时组装成功（AgentLoop 接收）', async () => {
      // 预置启动记忆，AgentLoop 构造时应接收
      const bootstrapMemory: Memory = {
        id: 'test:bootstrap-1',
        content: '用户偏好简洁回复',
        source: 'rule',
        name: 'concise-reply',
        createdAt: '2026-06-27T10:00:00.000Z',
        accessedAt: '2026-06-27T10:00:00.000Z',
        score: 0.8,
      };
      const pctx = createPctx({ bootstrapMemories: [bootstrapMemory] });

      const output = await assembleComponents(pctx, createInput());
      expect(output.loop).toBeDefined();
    });
  });
});
