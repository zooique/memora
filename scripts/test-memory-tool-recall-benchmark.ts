/**
 * A/B 模型行为验收 · 装载器 + 可达性自检
 *
 * 用法：
 *   npx tsx scripts/test-memory-tool-recall-benchmark.ts
 *
 * 职责（对照 docs/architecture/memory-tool-recall-ab-benchmark.md，种子 SSOT 见
 * scripts/benchmark-seeds.ts）：
 *  1. 把问题集（A 隐含相关 / B 显式提点）的目标记忆 seed 写入**隔离会话**，
 *     规避装配期正文与 search_memories 工具互斥对「当前会话热窗口」的排除。
 *  2. **可达性自检**：对每个 case 用理想查询调用 search_memories，断言能检索返回
 *     目标记忆的独特实体词——证明「果实可被搜索到」。若某 seed 连理想查询都命不中，
 *     则该 case 设计失效，需先修种子措辞而非直接上真实 LLM。
 *  3. 打印每个 case 的「用户输入 + 目标 id + 种子位置」，供真实 LLM 实跑
 *     （scripts/test-memory-tool-recall-real.ts）对照判定记录表填写。
 *
 * 边界（诚实声明）：本脚本只做「种子可装载 + 可被工具检索」两个前提自检，
 * **不替代**设计所定出口条件的 A/B 模型行为验收——想起率/命中率需真实 LLM +
 * 人工判答案优劣。
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
import { BENCH_SEEDS, BENCH_SESSION, OLD_ROUND, loadBenchmarkSeed } from './benchmark-seeds.js';

// ─── 断言工具：失败置 exitCode=1 但不中断后续检查 ──
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ❌ 断言失败: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ ${message}`);
  }
}

async function main(): Promise<void> {
  console.log('🧪 记忆召回 A/B 问题集 · 装载 + 可达性自检\n');

  const projectPath = await mkdtemp(join(tmpdir(), 'memora-benchmark-'));
  try {
    const storage = new InMemoryStorage();
    loadBenchmarkSeed(storage);
    const security = new SecurityGuard(projectPath, projectPath);
    const handlers = new BuiltinToolHandlers(projectPath, security, storage);
    // 不自注 setRecentRoundIdsProvider → 缺省不过滤（种子自检不看互斥，纯可达性）

    console.log(
      `已装载 ${BENCH_SEEDS.length} 个 seed（隔离会话=${BENCH_SESSION}，round 旧轮=${OLD_ROUND}）\n`,
    );

    // 可达性自检：对每个 case 用理想查询 search_memories，断言目标实体词被检索返回
    console.log('📋 可达性自检（理想查询 → 目标记忆实体词被检索返回）');
    for (const s of BENCH_SEEDS) {
      const result = await handlers.searchMemories(s.selfQuery, '10', 'match');
      // search_memories 返回格式 = `[source:name] (…)` + 预览正文，不含记忆 id；
      // 以独特实体词（必出现在正文字段里）判断该种子被检索返回 = 可达性成立
      const hit = result.includes(s.entity);
      assert(hit, `${s.id}（${s.input}）→ 目标 ${s.expectId} 可被 「${s.selfQuery}」 检索返回`);
    }

    console.log('\n📋 记录表（供真实 LLM 实跑时人工填写，对接基准文档 §3）');
    console.log('| case | input | expectId | queried? | hit? | 答案质量 | 判定 |');
    console.log('|---|---|---|---|---|---|---|');
    for (const s of BENCH_SEEDS) {
      console.log(`| ${s.id} | ${s.input} | ${s.expectId} | | | | |`);
    }

    console.log(`\n🎉 可达性自检完成（now=${nowIso()}）。全部目标可被工具检索 = 问题集果实可及。`);
    console.log('下一步：真实 LLM（云端/本地各一套）按 §0 口径驱动会话注入 input，逐 case 评');
    console.log('       queried/hit/答案优劣 → 填判定记录表 → 算 A 想起率 / B 命中率（脚本：');
    console.log('       scripts/test-memory-tool-recall-real.ts）。');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
}

// 执行主函数
main().catch((err) => {
  console.error('benchmark 脚本异常:', err);
  process.exit(1);
});
