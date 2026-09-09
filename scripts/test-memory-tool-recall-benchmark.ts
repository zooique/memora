/**
 * A/B 模型行为验收 · benchmark 装载器 + 可达性自检
 *
 * 用法：
 *   npx tsx scripts/test-memory-tool-recall-benchmark.ts
 *
 * 职责（对照 docs/architecture/memory-tool-recall-ab-benchmark.md）：
 *  1. 把问题集（A 隐含相关 / B 显式提点方）的目标记忆 seed 写入**隔离会话**，
 *     规避装配期正文与 search_memories 工具互斥（§5.1）对「当前会话热窗口」的排除。
 *  2. **可达性自检**：对每个 case 用理想查询调用 search_memories，断言能命中其
 *     目标记忆 id——证明「果实可被搜索到」。若某 seed 连理想查询都命不中，则该
 *     case 设计失效，需先修种子措辞而非直接上真实 LLM。
 *  3. 打印每个 case 的「用户输入 + 目标 id + 种子位置」，供真实 LLM 实跑时对照
 *     判定记录表人工填写 queried? / hit? / 答案质量。
 *
 * 边界（诚实声明）：本脚本只做「种子可装载 + 可被工具检索」两个前提自检，
 * **不替代**设计 §阶段1 出口条件的 A/B 模型行为验收——想起率/命中率需真实 LLM +
 * 人工判答案优劣，见基准文档 §4 跑测流程。
 *
 * 验收：脚本输出全部 ✅，process.exitCode = 0。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '../src/memory/inMemoryStorage.js';
import { BuiltinToolHandlers } from '../src/agent/builtinToolHandlers.js';
import { SecurityGuard } from '../src/security/pathGuard.js';
import { nowIso } from '../src/utils/time.js';
import type { Memory } from '../src/memory/types.js';

// ─── 断言工具（与 test-memory-tool-recall.ts 同构，SSOT：不造独立实现） ──

/** 断言工具函数：失败置 exitCode=1 但不中断后续检查 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ❌ 断言失败: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ ${message}`);
  }
}

// ─── 问题集 seed（对齐基准文档 §2，编号 go式一致） ─────────────

interface BenchmarkSeed {
  /** 用例编号（A1..A6 / B1..B4 / C 为反例不装载） */
  id: string;
  /** A 隐含相关 或 B 显式提点 */
  kind: 'A' | 'B';
  /** 目标记忆 id（判定「命中」的判据） */
  expectId: string;
  /** 真实用户输入（不含「上次/之前」字样 = A；含显式提点 = B） */
  input: string;
  /** 装载自检用的理想查询：应先于「用户输入」命中 expectId（可达性证明） */
  selfQuery: string;
  /** 独特实体词，避免与库内其它记忆语义混淆 */
  entity: string;
  /** 种子记忆来源 */
  source: Memory['source'];
  /** 种子内容（实测记忆正文） */
  content: string;
}

/** 隔离会话（跨主会话，规避装配正文互斥 + 不污染真实对话） */
const BENCH_SESSION = '2026-09-01-benchmark';
/** round-summary 类用例统一用旧轮（远于 HOT_MEMORY_MAX_ROUNDS 热窗口） */
const OLD_ROUND = 'r9-bench-seed';

/** 基准内存目标（与基准文档 §2 对应；C 组反例不装载种子） */
const BENCH_SEEDS: BenchmarkSeed[] = [
  // ── A 隐含相关 ──
  { id: 'A1', kind: 'A', expectId: 'content:lru-decision', input: '这个缓存要不要换方案，我之前权衡过的', selfQuery: '缓存进程内LRU决定', entity: 'ZizzleLru', source: 'content', content: 'ZizzleLru：缓存方案定为进程内 LRU（命中率优先，附带限层），理由见评审。' },
  { id: 'A2', kind: 'A', expectId: 'content:deploy-port', input: '帮我连一下线上的那个服务', selfQuery: '线上服务端口', entity: 'ZizzleDeploy', source: 'content', content: 'ZizzleDeploy：线上服务端口 8899、内网免鉴权，公网需 token。' },
  { id: 'A3', kind: 'A', expectId: 'content:style-pref', input: '这段代码风格保持跟我一贯一致', selfQuery: '代码风格偏好', entity: 'ZizzleStyle', source: 'content', content: 'ZizzleStyle：风格偏好双空格缩进、不用分号。' },
  { id: 'A4', kind: 'A', expectId: 'content:review-checklist', input: '这轮更新帮我按老规矩过一遍', selfQuery: '代码评审五维清单', entity: 'ZizzleReview', source: 'content', content: 'ZizzleReview：评审走五维清单（异步错误/分层/冗余/对抗CSS/安全性能）。' },
  { id: 'A5', kind: 'A', expectId: 'content:w42-fix', input: '这个报错又来了', selfQuery: 'W42报错解法', entity: 'ZizzleW42', source: 'content', content: 'ZizzleW42：报错 W-42 解法 = 清 token 缓存后重发。' },
  { id: 'A6', kind: 'A', expectId: 'round-summary:2026-09-01-benchmark:r9-bench-seed', input: '接口老超时，我们是打算怎么治的', selfQuery: '超时熔断决定', entity: 'ZizzleTimeout', source: 'round-summary', content: 'ZizzleTimeout：决定用超时熔断而非重试（曾论证重试放大雪崩）。' },
  // ── B 显式提点 ──
  { id: 'B1', kind: 'B', expectId: 'content:frobnicate', input: '上次那个文件再给我看下规范', selfQuery: 'frobnicate文件规范', entity: 'ZizzleFrobnicate', source: 'content', content: 'ZizzleFrobnicate：frobnicate.ts 需加文件级注释规范。' },
  { id: 'B2', kind: 'B', expectId: 'content:state-machine-B', input: '按之前定的方案把状态机接上', selfQuery: '状态机方案B', entity: 'ZizzleStateB', source: 'content', content: 'ZizzleStateB：状态机用方案 B（显式状态表）。' },
  { id: 'B3', kind: 'B', expectId: 'content:no-raw-sql', input: '我之前说过的那条约束别忘了', selfQuery: '不在生产跑裸SQL约束', entity: 'ZizzleNoSql', source: 'content', content: 'ZizzleNoSql：约束 = 生产不跑裸 SQL，须走查询构造器。' },
  { id: 'B4', kind: 'B', expectId: 'content:rollback-exit', input: '还记得我提的迁移出口吗', selfQuery: '可回滚迁移出口', entity: 'ZizzleRollback', source: 'content', content: 'ZizzleRollback：迁移需保留可回滚出口（双写过渡）。' },
];

/**
 * 装载基准种子到隔离会话（SSOT：只写 InMemoryStorage，不造独立存储实现）。
 * - content/preference：天然不受互斥影响（互斥只滤 round-summary 的 roundId）；
 * - round-summary：用旧轮（远于热窗口）并放隔离会话，双保险避开 §5.1 互斥。
 */
function loadBenchmarkSeed(storage: InMemoryStorage): void {
  for (const s of BENCH_SEEDS) {
    const base = {
      id: s.expectId,
      name: `${s.id} 种子`,
      content: s.content,
      source: s.source,
      score: 0.7,
    };
    if (s.source === 'round-summary') {
      storage.upsert({ ...base, sessionName: BENCH_SESSION, roundId: OLD_ROUND });
    } else {
      storage.upsert(base);
    }
  }
}

// ─── 主函数 ──────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🧪 记忆召回 A/B 问题集 · 装载 + 可达性自检\n');

  const projectPath = await mkdtemp(join(tmpdir(), 'memora-benchmark-'));
  try {
    const storage = new InMemoryStorage();
    loadBenchmarkSeed(storage);
    const security = new SecurityGuard(projectPath, projectPath);
    const handlers = new BuiltinToolHandlers(projectPath, security, storage);
    // 不自注 setRecentRoundIdsProvider → 缺省不过滤（种子自检不看互斥，纯可达性）

    console.log(`已装载 seed（隔离会话=${BENCH_SESSION}，round 旧轮=${OLD_ROUND}）\n`);

    // 可达性自检：对每个 case 用理想查询 search_memories，断言命中目标 id
    console.log('📋 可达性自检（理想查询 → 目标记忆实体词被检索返回）');
    for (const s of BENCH_SEEDS) {
      const result = await handlers.searchMemories(s.selfQuery, '10', 'match');
      // search_memories 返回格式 = `[source:name] (…)` + 预览正文，不含记忆 id；
      // 以独特实体词（必出现在正文字段里）判断该种子被检索返回 = 可达性成立
      const hit = result.includes(s.entity);
      assert(
        hit,
        `${s.id}（${s.input}）→ 目标 ${s.expectId} 可被 「${s.selfQuery}」 检索命中`,
      );
    }

    console.log('\n📋 记录表（供真实 LLM 实跑时人工填写，对接基准文档 §3）');
    console.log('| case | input | expectId | queried? | hit? | 答案质量 | 判定 |');
    console.log('|---|---|---|---|---|---|---|');
    for (const s of BENCH_SEEDS) {
      console.log(`| ${s.id} | ${s.input} | ${s.expectId} | | | | |`);
    }

    console.log(`\n🎉 可达性自检完成（now=${nowIso()}）。全部目标可被工具检索 = 问题集果实可及。`);
    console.log('下一步：真实 LLM（云端/本地各一套）按 §0 口径驱动会话注入 input，逐 case 评');
    console.log('       queried/hit/答案优劣 → 填判定记录表 → 算 A 想起率 / B 命中率。');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
}

// 执行主函数
main().catch((err) => {
  console.error('benchmark 脚本异常:', err);
  process.exit(1);
});