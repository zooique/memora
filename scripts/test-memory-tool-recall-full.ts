/**
 * A/B 模型行为验收 · 完整 Agent 装配复测（真实 LLM 会话驱动）
 *
 * 用途（对接 docs/architecture/memory-tool-recall-ab-benchmark.md §5 待办「真实实现复测」）：
 * 在「最小 tool-calling 环」（test-memory-tool-recall-real.ts）之外，用**完整 Agent 装配**
 * （角色包 + 全工具面 + 记忆互斥 + 轮次摘要/归档后台链路）重跑 A/B 问题集，
 * 确认「主动想起 + 命中」语义在真实装配下依然成立，而非最小环特例。
 *
 * 用法（复用 loadConfig 真实配置）：
 *   npx tsx scripts/test-memory-tool-recall-full.ts            # 全量 10 case（每 case 独立装配）
 *   $env:BENCH_CASE="A4,B2"; npx tsx scripts/...full.ts        # 指定 case
 *
 * 判定口径（与基准文档 §0/§3 一致，机制旁证法）：
 *  - queried? = 本轮收到 agent memoryRecalled 事件（search_memories 命中过 → LLM 主动检索）
 *  - hit?     = 目标 seed 的 accessedAt 被 touch 刷新（search_memories 命中目标记忆即 touch，
 *               与「工具返回文本含实体词」等价——touch 对象 = 返回结果里的命中记忆集合）
 *  - 答案质量 = 打印最终回答开头，人工评
 *
 * 与最小环的差异（如实呈现，不掩盖）：
 *  - 最小环 system prompt 显式引导「回答前先判断是否检索」；完整装配无此引导，
 *    「主动想起」完全靠角色包 + 工具描述的自然语义——这正是本复测要验证的。
 *  - 每 case 独立装配（新 Agent + 新临时库），对齐最小环的「每 case 独立上下文」。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import { createLlmProvider } from '../src/llm/factory.js';
import { InMemoryStorage } from '../src/memory/inMemoryStorage.js';
import { InMemorySessionStore } from '../src/memory/inMemorySessionStore.js';
import { Agent } from '../src/agent/agent.js';
import { AGENT_EVENTS } from '../src/utils/eventEmitter.js';
import { awaitBackgroundTasks } from '../src/utils/backgroundTask.js';
import { BENCH_SEEDS, loadBenchmarkSeed, type BenchmarkSeed } from './benchmark-seeds.js';

// Node 24 + undici 已知 bug：fetch 401/403 后 keep-alive stream 残留，process.exit 时触发
// libuv "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。与 smokeLlm.ts 同构兜底。
process.on('uncaughtException', (err) => {
  const isLibuvAssertion =
    err.name === 'AssertionError' || (err as NodeJS.ErrnoException).code === 'ERR_ASSERTION';
  const isAsyncClosing =
    String(err.message).includes('UV_HANDLE_CLOSING') ||
    String(err.stack ?? '').includes('async.c');
  if (isLibuvAssertion && isAsyncClosing) {
    process.stderr.write('\n⚠️  Node fetch 内部 stream 清理异常（已知 undici bug，业务错误已处理）\n');
    process.exit(1);
  }
  process.stderr.write(`💥 未捕获异常：${err.stack ?? err.message}\n`);
  process.exit(1);
});

/** 配置目录（含 role-packs/ 子目录）：脚本位于仓库根 scripts/ 下，取上级目录 */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
/** 激活的角色包名（完整装配的关键差异：角色包策略注入，而非最小环裸系统提示） */
const ACTIVE_ROLE_PACK = 'memora助手';

/** 单 case 判定结果 */
interface CaseVerdict {
  /** 是否主动检索（memoryRecalled 事件触发） */
  queried: boolean;
  /** 目标 seed 是否被 touch 命中（accessedAt 变化旁证） */
  hit: boolean;
  /** 最终回答开头（供人工评答案质量） */
  answerPreview: string;
  /** 本 case 耗时（ms） */
  elapsedMs: number;
}

/**
 * 执行一个 case：完整 Agent 装配 + 真实 LLM 驱动
 *
 * 每 case 独立装配（新临时库 + 新 Agent），避免会话上下文跨 case 延续污染判定。
 * 判定旁证：memoryRecalled 事件（queried）+ 目标记忆 accessedAt 变化（hit，search_memories 命中即 touch）。
 *
 * @param seed 基准 case 定义
 * @returns 判定结果
 */
async function runCase(seed: BenchmarkSeed): Promise<CaseVerdict> {
  const start = Date.now();

  // 1. 独立装配：临时项目 + 临时数据目录 + 种子库 + 内存会话存储
  const projectPath = await mkdtemp(join(tmpdir(), 'memora-full-'));
  const storage = new InMemoryStorage();
  loadBenchmarkSeed(storage);
  const sessionStore = new InMemorySessionStore();

  // 2. 真实 LLM Provider（与 test-memory-tool-recall-real.ts 同配置取法）
  const config = await loadConfig(process.env['SMOKE_CONFIG']);
  const provider = createLlmProvider(config);

  // 3. 完整 Agent 装配（角色包 + 全工具面 + 记忆互斥，全走内核默认链路）
  const agent = new Agent({
    projectPath,
    dataDir: join(projectPath, '.memora'),
    configDir: REPO_ROOT,
    activeRolePack: ACTIVE_ROLE_PACK,
    provider,
    storage,
    sessionStore,
    permission: 'owner',
    allowedPaths: [projectPath],
  });
  await agent.init();

  // 4. 判定旁证采集
  let queried = false;
  agent.on(AGENT_EVENTS.memoryRecalled, () => {
    queried = true; // LLM 主动调 search_memories 且命中（§2.4 保留改语义：命中即发射）
  });
  const before = storage.getById(seed.expectId)?.accessedAt; // 跑前 accessedAt（touch 旁证基线）

  // 5. 真实对话（chatSync = 流式聚合返回最终文本）
  const answer = await agent.chatSync(seed.input);
  // 命中即 touch 为 fire-and-forget（backgroundTask），等待其落库后再对比
  await awaitBackgroundTasks(2000);

  const after = storage.getById(seed.expectId)?.accessedAt; // 跑后 accessedAt
  const hit = before !== after; // accessedAt 变化 = 目标记忆被 search_memories 命中 touch

  const elapsedMs = Date.now() - start;
  await agent.close();
  await rm(projectPath, { recursive: true, force: true });

  return { queried, hit, answerPreview: answer.slice(0, 120).replace(/\n/g, ' '), elapsedMs };
}

/** 主流程：装载 case 列表 → 逐 case 完整装配复测 → 汇总 A/B 指标 */
async function main(): Promise<void> {
  console.log('🧪 完整 Agent 装配 A/B 复测（角色包 + 全工具面 + 记忆互斥）\n');

  // 1. 配置就绪检查
  const config = await loadConfig(process.env['SMOKE_CONFIG']);
  const providers = config.llm?.providers ?? {};
  const active = config.llm?.active ?? Object.keys(providers)[0] ?? '';
  const realActive = providers[active];
  if (!realActive?.apiKey) {
    console.error('❌ active provider 未配置 apiKey（PowerShell: $env:MEMORA_API_KEY = "sk-xxx"）');
    process.exit(1);
  }
  console.log(`Provider: ${config.llm.provider}`);
  console.log(`Model:    ${realActive.model ?? config.llm.model}`);
  console.log(`角色包:   ${ACTIVE_ROLE_PACK}`);

  // 2. 筛选 case（BENCH_CASE 环境变量可限定，默认全量）
  const filter = (process.env['BENCH_CASE'] ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const cases = filter.length ? BENCH_SEEDS.filter((s) => filter.includes(s.id)) : BENCH_SEEDS;
  if (cases.length === 0) {
    console.error(`❌ BENCH_CASE 无匹配 case：${filter.join(',')}`);
    process.exit(1);
  }

  // 3. 逐 case 完整装配复测
  console.log(`\n运行 ${cases.length} 个 case（BENCH_CASE=${filter.length ? filter.join(',') : 'all'}，每 case 独立装配）\n`);
  const results: Array<{ seed: BenchmarkSeed; v: CaseVerdict }> = [];
  for (const seed of cases) {
    try {
      const v = await runCase(seed);
      results.push({ seed, v });
      const mark = v.queried ? '✓' : '✗';
      const hitMark = v.hit ? '✓' : '✗';
      console.log(`[${seed.id}] 主动检索 ${mark} / 命中 ${hitMark}  <- ${seed.input}`);
      if (!v.hit) {
        console.log(`   回答开头：${v.answerPreview}`);
      }
    } catch (err) {
      console.error(`[${seed.id}] 💥 case 异常（计入未命中）：${(err as Error).message}`);
      results.push({ seed, v: { queried: false, hit: false, answerPreview: '', elapsedMs: 0 } });
    }
  }

  // 4. 判定记录表 + A/B 指标汇总（与基准文档 §0 口径一致）
  console.log('\n' + '━'.repeat(70));
  console.log('📋 判定记录表（queried=主动检索，hit=目标被 touch 命中）');
  console.log('| case | queried? | hit? | 耗时(ms) |');
  console.log('|---|---|---|---|');
  for (const { seed, v } of results) {
    console.log(`| ${seed.id} | ${v.queried ? '✓' : '✗'} | ${v.hit ? '✓' : '✗'} | ${v.elapsedMs} |`);
  }
  const aCases = results.filter((r) => r.seed.id.startsWith('A'));
  const bCases = results.filter((r) => r.seed.id.startsWith('B'));
  const aHit = aCases.filter((r) => r.v.queried && r.v.hit).length;
  const bHit = bCases.filter((r) => r.v.queried && r.v.hit).length;
  console.log('\n' + '━'.repeat(70));
  console.log('📊 指标（完整装配下；对照最小环见 test-memory-tool-recall-real.ts）');
  console.log(`   A 想起率 = ${aCases.length ? Math.round((aHit / aCases.length) * 100) : '-'}%（${aHit}/${aCases.length} 主动检索且命中）`);
  console.log(`   B 命中率 = ${bCases.length ? Math.round((bHit / bCases.length) * 100) : '-'}%（${bHit}/${bCases.length}，须 ≈100% 硬门槛）`);
  console.log('\n注：hit 旁证 = 目标记忆 accessedAt 被 touch 刷新（search_memories 命中即 touch）。');
  console.log('    答案质量需人工对照打印回答评断（本脚本不自动判优劣）。');
}

main()
  .then(() => {
    // 显式退出：避免 Node 24 + Windows + fetch 的 stream 关闭顺序问题
    process.exit(0);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    process.stderr.write(`💥 致命错误：\n${msg}\n`);
    process.exit(1);
  });
