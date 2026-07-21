/**
 * PersonaController 单元测试 — 精灵层角色控制器
 *
 * 测试目标：src/sprite/controllers/personaController.ts（精灵层 PersonaController 类）
 * 注意：与 electron/renderer/controllers/personaController.ts（渲染器层工厂函数）同名但不同层
 *
 * 覆盖范围：
 * - 构造函数：Agent 依赖注入
 * - activeName getter：正常返回 / persona manager 缺失降级 null
 * - list()：正常返回角色列表 / active 标记 / description 降级空串 / 空列表 / persona manager 缺失降级空数组
 * - setMode(mode)：auto/manual 设置 / persona manager 缺失降级 false
 * - currentMode getter：正常返回 / persona manager 缺失降级 'auto'
 * - PersonaInfo 接口：返回值结构包含 name/description/active 三字段
 *
 * 注意：切换逻辑由 Agent.switchPersona 承载，覆盖测试见
 *      src/agent/__tests__/agent.test.ts 的 "switchPersona" 区段。
 *
 * 测试策略（对齐 affectController.test.ts 范式）：
 * - 纯业务逻辑测试，无 I/O、无 LLM、无 DOM
 * - 通过 setLogger 注入 mock logger（避免 pino 日志输出污染测试）
 * - 创建 createMockAgent() / createMockPersonaManager() 工厂
 * - 禁止 @ts-ignore / as any，必要时用 as unknown as Type 单层断言
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersonaController } from '../../../sprite/controllers/personaController.js';
import type { PersonaInfo } from '../../../sprite/controllers/personaController.js';
import { setLogger } from 'memora';
import type { Agent, Persona, ILogger } from 'memora';

// ─── Mock 工厂 ──────────────────────────────────────────

/** 创建 Mock ILogger（静默日志输出，避免 pino 日志污染测试） */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** 创建测试用 Persona 对象 */
function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    name: 'test-persona',
    id: 'persona:test-persona',
    keywords: ['test'],
    content: '测试角色',
    filePath: '/test/persona.md',
    ...overrides,
  };
}

/** PersonaManager mock 的可控返回值配置 */
interface PersonaManagerMockOptions {
  /** activeName getter 返回值（默认 'default'） */
  activeName?: string;
  /** list getter 返回值（默认空数组） */
  list?: Persona[];
  /** currentMode getter 返回值（默认 'auto'） */
  currentMode?: 'auto' | 'manual';
  /** 自定义 setMode spy（默认内部创建） */
  setModeSpy?: ReturnType<typeof vi.fn>;
}

/**
 * 创建 Mock PersonaManager
 *
 * PersonaManager 类型未从 memora 公开导出，这里用对象字面量构造。
 * 通过 getter 模拟 activeName / list / currentMode 只读属性。
 *
 * 切换逻辑由 Agent.switchPersona 承载，PersonaController 不再委托到
 * PersonaManager.switchPersona。
 */
function createMockPersonaManager(opts: PersonaManagerMockOptions = {}) {
  // 创建 setMode spy，若外部传入则复用
  const setModeSpy = opts.setModeSpy ?? vi.fn();

  // 构造 mock 对象，getter 模拟只读属性
  const pm = {
    get activeName() {
      return opts.activeName ?? 'default';
    },
    get list() {
      return opts.list ?? [];
    },
    get currentMode() {
      return opts.currentMode ?? 'auto';
    },
    setMode: setModeSpy,
  };

  return {
    pm,
    spies: {
      setMode: setModeSpy,
    },
  };
}

/**
 * 创建 Mock Agent
 *
 * Agent 类型从 memora 公开导出，但其 persona 字段类型 PersonaManager 未公开。
 * 这里通过组合对象 + as unknown as Agent 单层断言构造测试替身。
 *
 * @param pm persona manager mock 对象，传 null 模拟 persona manager 缺失场景
 */
function createMockAgent(pm: unknown | null): Agent {
  return { persona: pm } as unknown as Agent;
}

// ─── Setup ──────────────────────────────────────────────

beforeEach(() => {
  // 注入 mock logger 避免 pino 日志输出污染测试
  setLogger(createMockLogger());
});

// ─── 构造函数 ────────────────────────────────────────────

describe('构造函数', () => {
  it('应接受 Agent 依赖注入并保存引用', () => {
    // 通过 activeName 验证 agent 引用已保存到实例
    const { pm } = createMockPersonaManager({ activeName: 'coder' });
    const agent = createMockAgent(pm);
    const controller = new PersonaController(agent);
    expect(controller.activeName).toBe('coder');
  });
});

// ─── activeName getter ──────────────────────────────────

describe('activeName getter', () => {
  it('persona manager 存在时返回当前激活角色名', () => {
    const { pm } = createMockPersonaManager({ activeName: 'writer' });
    const controller = new PersonaController(createMockAgent(pm));
    expect(controller.activeName).toBe('writer');
  });

  it('persona manager 缺失时降级返回 null', () => {
    // agent.persona 为 null 时，?? null 兜底生效
    const controller = new PersonaController(createMockAgent(null));
    expect(controller.activeName).toBeNull();
  });
});

// ─── list() ─────────────────────────────────────────────

describe('list()', () => {
  it('正常返回角色列表，包含 name/description/active 三字段', () => {
    const personas = [
      makePersona({ name: 'coder', description: '编程专家' }),
      makePersona({ name: 'writer', description: '写作助手' }),
    ];
    const { pm } = createMockPersonaManager({
      activeName: 'coder',
      list: personas,
    });
    const controller = new PersonaController(createMockAgent(pm));

    const result = controller.list();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: 'coder',
      description: '编程专家',
      active: true,
    });
    expect(result[1]).toEqual({
      name: 'writer',
      description: '写作助手',
      active: false,
    });
  });

  it('当前激活角色应标记 active=true，其余为 false', () => {
    const personas = [
      makePersona({ name: 'coder', description: '编程专家' }),
      makePersona({ name: 'writer', description: '写作助手' }),
    ];
    const { pm } = createMockPersonaManager({
      activeName: 'writer',
      list: personas,
    });
    const controller = new PersonaController(createMockAgent(pm));

    const result = controller.list();
    expect(result[0]?.active).toBe(false);
    expect(result[1]?.active).toBe(true);
  });

  it('description 为 undefined 时降级为空字符串', () => {
    // 源码使用 p.description ?? '' 兜底，未定义描述不应导致 undefined 泄漏
    const personas = [
      makePersona({ name: 'coder', description: undefined }),
    ];
    const { pm } = createMockPersonaManager({
      activeName: 'coder',
      list: personas,
    });
    const controller = new PersonaController(createMockAgent(pm));

    const result = controller.list();
    expect(result[0]?.description).toBe('');
  });

  it('空角色列表时返回空数组', () => {
    const { pm } = createMockPersonaManager({ list: [] });
    const controller = new PersonaController(createMockAgent(pm));
    expect(controller.list()).toEqual([]);
  });

  it('persona manager 缺失时降级返回空数组', () => {
    // agent.persona 为 null 时直接返回 []，不抛异常
    const controller = new PersonaController(createMockAgent(null));
    expect(controller.list()).toEqual([]);
  });

  it('返回值符合 PersonaInfo 接口结构（name/description/active 字段齐全）', () => {
    const personas = [makePersona({ name: 'coder', description: '编程专家' })];
    const { pm } = createMockPersonaManager({
      activeName: 'coder',
      list: personas,
    });
    const controller = new PersonaController(createMockAgent(pm));

    // 显式标注类型，验证返回值可赋给 PersonaInfo[]
    const result: PersonaInfo[] = controller.list();
    const first = result[0];
    expect(first).toHaveProperty('name', 'coder');
    expect(first).toHaveProperty('description', '编程专家');
    expect(first).toHaveProperty('active', true);
  });
});

// 角色切换逻辑统一由 Agent.switchPersona 公共方法承载（事件链路 + 错误吞没），
// 覆盖测试见 src/agent/__tests__/agent.test.ts 的 "switchPersona" 区段。

// ─── setMode(mode) ──────────────────────────────────────

describe('setMode(mode)', () => {
  it('设置 auto 模式成功返回 true', () => {
    const { pm, spies } = createMockPersonaManager();
    const controller = new PersonaController(createMockAgent(pm));

    const result = controller.setMode('auto');
    expect(result).toBe(true);
    expect(spies.setMode).toHaveBeenCalledWith('auto');
  });

  it('设置 manual 模式成功返回 true', () => {
    const { pm, spies } = createMockPersonaManager();
    const controller = new PersonaController(createMockAgent(pm));

    const result = controller.setMode('manual');
    expect(result).toBe(true);
    expect(spies.setMode).toHaveBeenCalledWith('manual');
  });

  it('persona manager 缺失时降级返回 false', () => {
    // agent.persona 为 null 时直接返回 false，不调用 setMode
    const controller = new PersonaController(createMockAgent(null));
    expect(controller.setMode('auto')).toBe(false);
  });
});

// ─── currentMode getter ─────────────────────────────────

describe('currentMode getter', () => {
  it('persona manager 存在时返回其当前模式（manual）', () => {
    const { pm } = createMockPersonaManager({ currentMode: 'manual' });
    const controller = new PersonaController(createMockAgent(pm));
    expect(controller.currentMode).toBe('manual');
  });

  it('persona manager 存在时返回其当前模式（auto）', () => {
    const { pm } = createMockPersonaManager({ currentMode: 'auto' });
    const controller = new PersonaController(createMockAgent(pm));
    expect(controller.currentMode).toBe('auto');
  });

  it('persona manager 缺失时降级返回默认值 "auto"', () => {
    // agent.persona 为 null 时，?? 'auto' 兜底生效
    const controller = new PersonaController(createMockAgent(null));
    expect(controller.currentMode).toBe('auto');
  });
});
