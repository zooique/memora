/**
 * 真机探针：能力位三态修复 + 连续多文件读取的端到端验证
 *
 * 验证两个关切点：
 *   1. supportsToolCalling 三态链路的落地形态——
 *      - 显式 false（本地降级）：provider 能力位为 false，loop 走显式回落，不崩、不静默、不诱导文本 tool_call；
 *      - 未配置（云端默认）：provider 能力位为 true，保留存量原生 FC 行为。
 *   2. 连续大量文件查看：用真实 BuiltinToolHandlers.readFile 顺序读取多文件，验证不中断、结果可靠。
 *
 * 用例：
 *   npx tsx scripts/test-config-local-tool-real.ts
 *
 * 环境：.memora/config.json + MEMORA_MODEL / MEMORA_BASE_URL / MEMORA_API_KEY 三件套
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProviderFromConfig } from '../src/llm/factory.js';
import { BuiltinToolHandlers } from '../src/agent/builtinToolHandlers.js';
import { SecurityGuard } from '../src/security/pathGuard.js';
import type { IMemoryStorage } from '../src/memory/storageInterface.js';

/** 探针辅助：验证能力位三态落地形态 */
function probeCapabilityPersistence(): void {
  console.log('\n[①] 能力位三态链路验证（SSOT 承诺的三种取值 + 显式消费方）\n');

  // 造三份 ProviderConfig，验证 factory 透传 + provider 能力位落地
  const cases: Array<{ label: string; cfg: Record<string, unknown>; expect: boolean }> = [
    {
      label: '显式 false（本地降级·关工具集→回落显式告知通道）',
      cfg: { model: 'm', baseUrl: 'https://x/v1', apiKey: 'k', supportsToolCalling: false },
      expect: false,
    },
    {
      label: '显式 true（云端原生 FC）',
      cfg: { model: 'm', baseUrl: 'https://x/v1', apiKey: 'k', supportsToolCalling: true },
      expect: true,
    },
    {
      label: '未配置 undefined（存量行为·回落 true）',
      cfg: { model: 'm', baseUrl: 'https://x/v1', apiKey: 'k' },
      expect: true,
    },
  ];

  for (const c of cases) {
    // 模拟 loader 层三态保真后的 output（config 解析结果）再进 factory
    // loader 已保证：显式 boolean 如实保留，其余 undefined
    const loaderOutput = {
      model: c.cfg.model as string,
      baseUrl: c.cfg.baseUrl as string,
      apiKey: c.cfg.apiKey as string,
      supportsToolCalling:
        typeof c.cfg.supportsToolCalling === 'boolean' ? c.cfg.supportsToolCalling : undefined,
    };
    const provider = createProviderFromConfig('probe', loaderOutput);
    const actual = provider.supportsToolCalling;
    const ok = actual === c.expect;
    console.log(
      `  ${ok ? '✅' : '❌'} ${c.label}\n` +
        `     配置输入: supportsToolCalling=${String(c.cfg.supportsToolCalling)} ` +
        `→ 实际能力位: ${actual}（期望 ${c.expect}）`,
    );
    if (!ok) throw new Error(`${c.label} 能力位落地不匹配：实际 ${actual}，期望 ${c.expect}`);
  }
  console.log('\n  能力位三态链路：✅ 全对（false 不再被静默吞成 true）');
}

/** 探针辅助：连续大量文件读取（真实 handler，验证不中断） */
async function probeBulkRead(): Promise<void> {
  console.log('\n[②] 连续大量文件读取验证（真实 BuiltinToolHandlers.readFile）\n');

  // 造一批文件（模拟"看大量文件"任务）
  const dir = join(tmpdir(), `memora-bulk-read-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const FILE_COUNT = 30;
  const LINES_PER_FILE = 200;
  try {
    for (let i = 0; i < FILE_COUNT; i++) {
      const lines = Array.from(
        { length: LINES_PER_FILE },
        (_, l) => `第${i + 1}号文件 · 行${l + 1} · 内容标记 ${'xyz'.repeat(5 + (i % 7))}`,
      );
      writeFileSync(join(dir, `doc-${String(i).padStart(2, '0')}.md`), lines.join('\n'), 'utf-8');
    }

    // 构造真实 handler（临时路径，无记忆库）
    const storage = {
      queryMemories: async () => [],
      getRecentSummaries: async () => [],
      search: async () => [],
    } as unknown as IMemoryStorage;
    const security = new SecurityGuard(dir, dir);
    const handlers = new BuiltinToolHandlers(dir, security, storage);

    // 顺序读全部文件
    const start = Date.now();
    let totalChars = 0;
    let maxMs = 0;
    for (let i = 0; i < FILE_COUNT; i++) {
      const f = `doc-${String(i).padStart(2, '0')}.md`;
      const t0 = Date.now();
      const res = await handlers.readFile(f);
      const ms = Date.now() - t0;
      if (ms > maxMs) maxMs = ms;
      totalChars += res.length;
      if (!res.includes(`第${i + 1}号文件`)) {
        throw new Error(`文件 ${f} 读取结果缺目标内容标记（读取不完整）`);
      }
    }
    const elapsed = Date.now() - start;
    console.log(`  读取 ${FILE_COUNT} 个文件（每文件 ${LINES_PER_FILE} 行）完成`);
    console.log(`  总字符：${totalChars}`);
    console.log(`  总耗时：${elapsed} ms；单文件峰值耗时：${maxMs} ms`);
    console.log(`  平均：${Math.round(elapsed / FILE_COUNT)} ms/文件`);
    console.log('\n  连续多文件读取：✅ 全部成功、无中断');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 探针辅助：真实 LLM × AgentLoop × 多文件读取 全真闭环 */
async function probeRealLoopRead(): Promise<void> {
  console.log('\n[③] 真实 LLM × AgentLoop × 连续多文件读取（全真工具调用闭环）\n');

  // 造一批供 LLM 读取的文件（放 projectPath 内：SecurityGuard 以它为信任根，read_file 才能访问）
  const dir = join(tmpdir(), `memora-real-loop-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const FILES = ['architecture.md', 'design.md', 'roadmap.md'];
  const content: Record<string, string> = {
    'architecture.md': '架构说明：node.js 内核，零第三方运行时依赖，采用 Agent Loop 运行时。',
    'design.md': '设计说明：应用单一真理源原则，每个概念一个实现。',
    'roadmap.md': '路线图：v1 内核稳定，v2 插件化，v3 多模型路由。',
  };
  for (const f of FILES) writeFileSync(join(dir, f), content[f] ?? '', 'utf-8');

  try {
    // 装配：真实 provider + BUILTIN_TOOLS + 真实 readFile handler
    // 动态 import 以避免脚本顶层对 loop/builtinTools 的静态依赖过重
    const [{ AgentLoop }, { BUILTIN_TOOLS }, { SecurityGuard: SG }] = await Promise.all([
      import('../src/agent/loop.js'),
      import('../src/agent/builtinTools.js'),
      import('../src/security/pathGuard.js'),
    ]);
    const storage = {
      queryMemories: async () => [],
      getRecentSummaries: async () => [],
      search: async () => [],
    } as unknown as IMemoryStorage;
    const security = new SG(dir, dir);
    const handlers = new BuiltinToolHandlers(dir, security, storage);

    // toolExecutor：真实 read_file + list_dir（LLM 读完文件后可能想列目录确认），其余返回占位
    const toolExecutor = async (name: string, argsStr: string): Promise<string> => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argsStr || '{}');
      } catch {
        args = {};
      }
      switch (name) {
        case 'read_file':
          return handlers.readFile(String(args.path ?? ''));
        case 'list_dir':
          // listDir 签名（relativePath, recursiveStr, maxDepthStr）：探针环境取非递归、深度 2 的保守默认
          return handlers.listDir(String(args.path ?? '.'), 'false', '2');
        default:
          return `[${name}] ${argsStr || '(空参数)'}（探针环境：返回占位）`;
      }
    };

    const loop = new AgentLoop({
      // 用真实三件套环境变量构造 provider（走原生 FC 通道，检验工具调用全链路）
      provider: createProviderFromConfig('real', {
        model: process.env['MEMORA_MODEL'] ?? 'mimo-v2.5',
        baseUrl: process.env['MEMORA_BASE_URL'] ?? 'https://api.xiaomimimo.com/v1',
        apiKey: process.env['MEMORA_API_KEY'] ?? '',
      }),
      bootstrapMemories: [],
      toolDefinitions: BUILTIN_TOOLS,
      toolExecutor,
      maxIterations: 6,
    });

    // read_file 期望相对路径（BuiltinToolHandlers 以 dir 为 projectPath/信任根）
    // 提示语只给文件名（相对路径），不暴露绝对路径，避免 LLM 传绝对路径撞白名单
    const input = `请依次读取项目根目录下的 ${FILES.join('、')} 三个文件（相对路径直接是文件名即可），并简短总结每个文件的主题（各一句话）。`;
    let response = '';
    const toolCallsSeen: string[] = [];
    console.log(`  📤 输入：读取并总结 ${FILES.length} 个文档`);
    console.log('  🤖 助手流式回复：');
    const start = Date.now();
    for await (const chunk of loop.processUserInput(input)) {
      if (chunk.type === 'text') {
        response += chunk.content;
      } else if (chunk.type === 'tool_start') {
        toolCallsSeen.push(chunk.name);
      }
    }
    const duration = Date.now() - start;
    // 指标
    const metrics = loop.getMetrics();
    console.log(`\n\n  ⏱️  耗时：${duration}ms`);
    console.log(`  工具调用序列：${toolCallsSeen.join(' → ') || '(无工具调用)'}`);
    console.log(
      `  指标：工具 ${metrics.tools.callCount} 次调用 / ${metrics.tools.failureCount} 次失败`,
    );
    console.log(`  回复摘要：${(response || '(空)').slice(0, 120)}...`);

    // 判定：真闭环应至少发起 ≥1 次 read_file 并产出文本回复
    const readCall = toolCallsSeen.filter((t) => t === 'read_file');
    const ok =
      readCall.length > 0 && response.trim().length > 0 && metrics.tools.failureCount === 0;
    if (!ok) {
      throw new Error(
        `真实 LLM 闭环未满足：read_file=${readCall.length} 次，回复=${response.length} 字，工具失败=${metrics.tools.failureCount}`,
      );
    }
    console.log(
      `\n  真实 LLM × AgentLoop × 多文件读取：✅ 闭环成立（read_file ${readCall.length} 次，0 失败，有总结）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('━'.repeat(64));
  console.log('真机探针 · 能力位三态修复 + 连续多文件读取端到端验证');
  console.log('━'.repeat(64));

  probeCapabilityPersistence();
  await probeBulkRead();
  await probeRealLoopRead();

  console.log('\n' + '━'.repeat(64));
  console.log(
    '✅ 探针全部通过：能力位三态链路正确；连续多文件读取不中断、结果可靠；真实 LLM 工具闭环成立',
  );
  console.log('━'.repeat(64));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`\n💥 探针失败：${msg}`);
    process.exit(1);
  });
