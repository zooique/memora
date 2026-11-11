/**
 * 子会话（delegate_task）装配与派发测试
 *
 * 覆盖四类结构约束：
 *   1. 暴露面减法：写盘/执行/交互/父状态工具不可见，search_memories 保留；
 *   2. 不继承宿主自定义工具注册表（P0-2 的核心：MCP 写工具不能漏进子会话）；
 *   3. 深度 1 结构性：子执行器没有 delegateTask 端口 ⇒ delegate_task 不可见；
 *   4. 终态头部由内核生成（[SUBAGENT:*]），含中断/失败路径。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from '@/agent/toolExecutor.js';
import { SecurityGuard } from '@/security/pathGuard.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import {
  createSubagentLoop,
  createSubagentToolExecutor,
  formatSubagentResult,
  runSubagent,
  type SubagentRuntimeParams,
} from '@/agent/assembler.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import type { SkillManager } from '@/skill/skillManager.js';

/** 全局技能桩：子会话只应看到「全局」这一层 */
const skillManagerStub = {
  get: (name: string) => (name === 'global-one' ? { content: 'GLOBAL-BODY' } : undefined),
  readResource: async () => null,
  listResources: () => [],
  listAvailable: () => [],
  buildSkillList: () => '【全局技能清单】',
} as unknown as SkillManager;

/** 角色包桩：记录 buildSystemPrompt 收到的装配开关（断言子装配确实跳过内嵌技能/提问规则） */
function createRolePackManagerStub(known: string[] = ['reviewer']) {
  const calls: Array<{ name?: string; options?: unknown }> = [];
  const manager = {
    listMeta: () => known.map((name) => ({ name })),
    get: () => null,
    buildSystemPrompt: (name?: string, options?: unknown) => {
      calls.push({ name, options });
      return 'PERSONA-BASE';
    },
  } as unknown as RolePackManager;
  return { manager, calls };
}

/** 最小 LLM Provider：按给定行为产出/抛错 */
function createProvider(behavior: 'ok' | 'throw', content = '子会话的最终回答'): LlmProvider {
  return {
    name: 'mock',
    async *chat() {
      if (behavior === 'throw') throw new Error('模拟子会话 LLM 失败');
      yield { content };
    },
  } as unknown as LlmProvider;
}

/**
 * 在临时目录里建一套子会话装配参数（用完清理）
 */
async function withRuntimeParams(
  fn: (params: SubagentRuntimeParams) => Promise<void> | void,
  overrides: Partial<SubagentRuntimeParams> = {},
): Promise<void> {
  const projectPath = await mkdtemp(join(tmpdir(), 'memora-subagent-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'memora-subagent-data-'));
  try {
    const params: SubagentRuntimeParams = {
      provider: createProvider('ok'),
      projectPath,
      security: new SecurityGuard(projectPath, dataDir, [], false, 'owner'),
      memoryIndex: new InMemoryStorage(),
      rolePackManager: createRolePackManagerStub().manager,
      skillManager: skillManagerStub,
      ...overrides,
    };
    await fn(params);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe('子会话工具暴露面', () => {
  it('写盘/执行/交互/父状态工具全部不可见，search_memories 保留', async () => {
    await withRuntimeParams((params) => {
      const exec = createSubagentToolExecutor(params, { task: '调查' });
      const names = exec.list.map((t) => t.name);

      for (const denied of [
        'write_file',
        'delete_file',
        'run_command',
        'kill_command',
        'run_project_script',
        'run_skill_script',
        'run_code',
        'ask_user',
        'remember_intel',
        'task_table_write',
        'task_table_update',
        'register_work',
        'run_team_meeting',
      ]) {
        expect(names).not.toContain(denied);
      }
      // 只读核心能力必须保留（禁掉等于子会话瞎掉）
      expect(names).toContain('read_file');
      expect(names).toContain('search_memories');
    });
  });

  it('不继承宿主自定义工具注册表（P0-2：MCP 写工具不能漏进子会话）', async () => {
    await withRuntimeParams((params) => {
      // 父会话注册一个自定义写工具（模拟 MCP 共享注册表）
      const parent = new ToolExecutor(params.projectPath, params.security, params.memoryIndex);
      parent.registerTool(
        {
          name: 'mcp_write_thing',
          description: '自定义写工具',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        async () => 'written',
      );
      expect(parent.list.map((t) => t.name)).toContain('mcp_write_thing');

      // 子会话是全新执行器 ⇒ 结构上没有该工具
      const child = createSubagentToolExecutor(params, { task: '调查' });
      expect(child.list.map((t) => t.name)).not.toContain('mcp_write_thing');
    });
  });

  it('深度 1：子执行器没有 delegateTask 端口 ⇒ delegate_task 不可见', async () => {
    await withRuntimeParams((params) => {
      const child = createSubagentToolExecutor(params, { task: '调查' });
      expect((child as unknown as { delegateTask?: unknown }).delegateTask).toBeUndefined();
      expect(child.list.map((t) => t.name)).not.toContain('delegate_task');
    });
  });

  it('capabilities 只接受 web:search / web:fetch，其余报错', async () => {
    await withRuntimeParams((params) => {
      expect(() =>
        createSubagentToolExecutor(params, { task: '调查', capabilities: ['code:execute'] }),
      ).toThrow(/不支持/);
      // 未授予时联网工具不出现
      const noCap = createSubagentToolExecutor(params, { task: '调查' });
      expect(noCap.list.map((t) => t.name)).not.toContain('web_search');
    });
  });

  it('授予 web:search 且注入 provider 时 web_search 可见', async () => {
    await withRuntimeParams(
      (params) => {
        const exec = createSubagentToolExecutor(params, {
          task: '查资料',
          capabilities: ['web:search'],
        });
        expect(exec.list.map((t) => t.name)).toContain('web_search');
      },
      { webSearchProvider: { search: async () => [] } as never },
    );
  });

  it('read_skill 只解析全局技能（角色包内嵌技能不可见）', async () => {
    await withRuntimeParams(async (params) => {
      const exec = createSubagentToolExecutor(params, { task: '调查' });
      expect(await exec.readSkill!('global-one')).toBe('GLOBAL-BODY');
      // 角色包内嵌技能（非全局）→ null，而不是走角色包解析链
      expect(await exec.readSkill!('pack-embedded')).toBeNull();
    });
  });
});

describe('子会话角色包与提示词装配', () => {
  it('rolePack 不存在时工具报错，不静默退回空白', async () => {
    await withRuntimeParams((params) => {
      expect(() => createSubagentLoop(params, { task: '评审', rolePack: '不存在的包' })).toThrow(
        /角色包不存在/,
      );
    });
  });

  it('rolePack 存在时调用 buildSystemPrompt 并跳过内嵌技能 / 提问规则', async () => {
    await withRuntimeParams((params) => {
      const stub = createRolePackManagerStub(['reviewer']);
      const runtime = createSubagentLoop(
        { ...params, rolePackManager: stub.manager },
        { task: '评审', rolePack: 'reviewer' },
      );
      expect(runtime.systemPromptPrefix).toContain('PERSONA-BASE');
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.name).toBe('reviewer');
      expect(stub.calls[0]!.options).toEqual({
        includeSkills: false,
        suppressFollowupAsk: true,
      });
    });
  });

  it('不继承父角色包：未传 rolePack 时不调用 buildSystemPrompt（仍是空白 persona）', async () => {
    await withRuntimeParams((params) => {
      const stub = createRolePackManagerStub(['reviewer']);
      const runtime = createSubagentLoop(
        { ...params, rolePackManager: stub.manager },
        { task: '调查' },
      );
      expect(stub.calls).toHaveLength(0);
      // 空白默认仍注入全局技能清单 / 时间戳等固定段
      expect(runtime.systemPromptPrefix).toContain('【全局技能清单】');
      expect(runtime.systemPromptPrefix).toContain('当前时间：');
    });
  });
});

describe('子会话结果头部由内核生成', () => {
  it('formatSubagentResult 的第一行恒为 [SUBAGENT:*]', () => {
    expect(formatSubagentResult('completed', '答案').split('\n')[0]).toBe('[SUBAGENT:completed]');
    expect(formatSubagentResult('interrupted', '').split('\n')[0]).toBe('[SUBAGENT:interrupted]');
    expect(formatSubagentResult('failed', '半截').split('\n')[0]).toBe('[SUBAGENT:failed]');
  });

  it('正文超过 20,000 字符时截断，且头部完整', () => {
    const long = 'x'.repeat(20_005);
    const result = formatSubagentResult('completed', long);
    const [header, ...rest] = result.split('\n');
    expect(header).toBe('[SUBAGENT:completed]');
    // 正文保留前 20,000 字符后追加截断提示（提示本身不计入上限）
    expect(rest.join('\n').startsWith('x'.repeat(20_000))).toBe(true);
    expect(rest.join('\n')).toContain('已截断');
  });

  it('正常完成：头部来自流终态，正文是子会话最终回答', async () => {
    await withRuntimeParams(async (params) => {
      const result = await runSubagent(params, { task: '调查' });
      expect(result.startsWith('[SUBAGENT:completed]\n')).toBe(true);
      expect(result).toContain('子会话的最终回答');
    });
  });

  it('父 signal 已中止：收口为 [SUBAGENT:interrupted]', async () => {
    await withRuntimeParams(async (params) => {
      const controller = new AbortController();
      controller.abort();
      const result = await runSubagent(params, { task: '调查' }, controller.signal);
      expect(result.startsWith('[SUBAGENT:interrupted]')).toBe(true);
    });
  });

  it('子会话抛错：收口为 [SUBAGENT:failed]', async () => {
    await withRuntimeParams(
      async (params) => {
        const result = await runSubagent(params, { task: '调查' });
        expect(result.startsWith('[SUBAGENT:failed]')).toBe(true);
      },
      { provider: createProvider('throw') },
    );
  });
});
