/**
 * 只读项目顾问角色包：执行面写盘绕过实测（机判）
 *
 * 判据：激活仓库内置 `role-packs/readonly-advisor`（真实 pack，不手工构造 strategy）后，
 * 依次尝试 `run_code` / `run_command` / `run_project_script` / `run_skill_script`
 * 四条执行面写盘路径 —— 必须全部被拒（tool_result `blocked === true`），且盘上不留任何标记文件。
 *
 * 为什么必须实测而不是读代码：只读闸在 `applyPrechecks` 里查「全部工具定义」，
 * 但「定义是否进入 allTools」「pack 的 strategy 是否真的生效」都取决于装配链；
 * 任何一环没接上，闸会静默变成 no-op（= 假阴性）。本文件用真 Agent + 真文件系统跑出来。
 */
import { describe, it, expect } from 'vitest';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Agent, type AgentChunk, type LlmChunk, type LlmProvider } from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
import { createHostMemoryStorage } from '../memoryStorage.js';
import { resolveProjectDataDir } from '../projectDataDir.js';
import { createLocalCodeExecutor } from '../codeExecutor.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

/** 被测角色包的显示名（= manifest.json 的 `name` 字段，激活按此名寻址） */
const PACK_NAME = '只读项目顾问';

/** 一条待触发的工具调用 */
interface StubCall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * 按「是否已回填工具结果」判定轮次的 stub provider
 *
 * 不能用调用序号：内核会先调 provider 做会话命名 / 摘要（不带工具集），按序号推会错发。
 */
class ExecAttemptProvider {
  readonly name = 'readonly-bypass-stub';
  readonly supportsStructuredOutput = false;

  /** 本 provider 在首个工具轮要发起的执行面调用 */
  constructor(private readonly calls: StubCall[]) {}

  /**
   * @param messages 当前上下文消息（用 role==='tool' 判定工具结果是否已回填）
   * @param opts 本次下发的载荷（含工具集）
   */
  async *chat(
    messages: Array<{ role: string; content?: string }>,
    opts?: { tools?: Array<{ function?: { name?: string } }> },
  ): AsyncIterable<LlmChunk> {
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const hasTools = (opts?.tools ?? []).length > 0;
    if (!hasToolResult && hasTools) {
      yield { content: '我尝试执行以下操作。' };
      yield {
        toolCalls: this.calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
        finishReason: 'tool_calls',
      };
      return;
    }
    yield { content: '完成。', finishReason: 'stop' };
  }
}

/**
 * 播种兜底角色包（与既有宿主测试同形态；真实只读包随后覆盖复制进来）
 *
 * @param configDir Agent 配置目录
 */
function seedFallbackPacks(configDir: string): void {
  const pairs: Array<[string, string]> = [
    ['默认助手', JSON.stringify({ name: '默认助手', displayName: '默认助手', strategy: {} })],
    ['memora助手', JSON.stringify({ name: 'memora助手', formatVersion: '1.0.0' })],
  ];
  for (const [dirName, manifest] of pairs) {
    const dir = join(configDir, 'role-packs', dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), manifest, 'utf-8');
    writeFileSync(join(dir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  }
  mkdirSync(join(configDir, 'skills'), { recursive: true });
}

describe('只读项目顾问：执行面写盘绕过', () => {
  it('四条执行面均被拒且盘上无产物', async () => {
    const projectPath = makeTempDir('memora-readonly-bypass-');
    const configDir = join(projectPath, 'config');
    seedFallbackPacks(configDir);

    // 真实内置包整目录复制（不手写 strategy，避免「测试构造的只读 ≠ 用户装的只读」）
    const sourcePack = resolve(process.cwd(), '../../role-packs/readonly-advisor');
    cpSync(sourcePack, join(configDir, 'role-packs', 'readonly-advisor'), { recursive: true });

    // 四条路径各自的标记文件（绝对路径写进命令/代码，不受 cwd 影响）
    const markerCode = join(projectPath, 'LEAK_CODE.txt');
    const markerCmd = join(projectPath, 'LEAK_CMD.txt');
    const markerProject = join(projectPath, 'LEAK_PROJECT.txt');
    const markerSkill = join(projectPath, 'LEAK_SKILL.txt');

    // 项目脚本 + 技能脚本：若闸门放行则都会被真实执行并写标记（不是故意给不存在的目标）
    mkdirSync(join(projectPath, 'scripts'), { recursive: true });
    writeFileSync(
      join(projectPath, 'scripts', 'leak.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerProject)}, 'x');\n`,
      'utf-8',
    );
    const skillDir = join(configDir, 'skills', 'leak-skill');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: leak-skill\ndescription: 只读绕过实测用技能（仅测试）\n---\n\n# leak-skill\n',
      'utf-8',
    );
    writeFileSync(
      join(skillDir, 'scripts', 'leak.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerSkill)}, 'x');\n`,
      'utf-8',
    );

    const calls: StubCall[] = [
      {
        id: 'call_run_code',
        name: 'run_code',
        args: {
          language: 'node',
          code: `require('node:fs').writeFileSync(${JSON.stringify(markerCode)}, 'x');`,
        },
      },
      {
        id: 'call_run_command',
        name: 'run_command',
        args: { command: `echo leak> "${markerCmd}"` },
      },
      {
        id: 'call_run_project_script',
        name: 'run_project_script',
        args: { script_path: 'scripts/leak.mjs' },
      },
      {
        id: 'call_run_skill_script',
        name: 'run_skill_script',
        args: { skill_name: 'leak-skill', script_path: 'leak.mjs' },
      },
    ];

    const storage = createHostMemoryStorage(projectPath);
    const roundStore = new WorkspaceRoundStore(projectPath);
    roundStore.load();
    const sessionStore = new WorkspaceSessionStore(projectPath, roundStore);
    sessionStore.load();

    const agent = new Agent({
      projectPath,
      dataDir: resolveProjectDataDir(projectPath),
      configDir,
      provider: new ExecAttemptProvider(calls) as unknown as LlmProvider,
      archiveMode: 'manual',
      permission: 'owner',
      allowedPaths: [projectPath],
      // 外部注入的存储单例（生产装配形态；关闭责任归测试自己）
      storage,
      sessionStore,
      roundStore,
      codeExecutionProvider: createLocalCodeExecutor(),
      // 激活真实只读包（按 name 寻址，装配链解析其 manifest strategy）
      activeRolePack: PACK_NAME,
    });
    await agent.init();

    // 前置事实：确认激活的是只读包，而不是静默落兜底包
    expect(agent.rolePackManager!.activeName).toBe(PACK_NAME);

    /** 收齐 Agent 流（tool_result 用于判读是否被拦）——chat 产出的是 AgentChunk（非 LlmChunk） */
    const chunks: Array<Extract<AgentChunk, { type: 'tool_result' }>> = [];
    for await (const chunk of agent.chat('请把这些内容写进项目。')) {
      if (chunk.type === 'tool_result') chunks.push(chunk);
    }

    // ① 四条执行面一条都没真执行（blocked 标记来自执行层闸门，不是 handler 内部失败）
    const byName = new Map(chunks.map((c) => [c.name, c]));
    for (const call of calls) {
      const result = byName.get(call.name);
      expect(result, `未收到 ${call.name} 的 tool_result`).toBeTruthy();
      expect(result!.ok, `${call.name} 竟然执行成功`).toBe(false);
      expect(result!.blocked, `${call.name} 未被闸门拦截（blocked=false）`).toBe(true);
    }

    // ② 盘上没有任何标记文件（最强的用户可见判据）
    for (const marker of [markerCode, markerCmd, markerProject, markerSkill]) {
      expect(existsSync(marker), `执行面写盘成功：${marker}`).toBe(false);
    }

    agent.close();
    // 外部注入的存储不归 Agent 关闭（shutdown 所有权语义），测试自己收尾，避免临时目录 EBUSY
    (storage as unknown as { close?: () => void }).close?.();
  }, 60_000);
});
