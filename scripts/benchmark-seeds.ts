/**
 * A/B 验收 · 问题集种子（单一真理源）
 *
 * 被两个脚本共享（SSOT，不复制）：
 *  - scripts/test-memory-tool-recall-benchmark.ts：装载 + 可达性自检
 *  - scripts/test-memory-tool-recall-real.ts：真实 LLM 会话驱动 A/B 实测
 *
 * 对齐基准：docs/architecture/memory-tool-recall-ab-benchmark.md §2。
 * C 组为「反例」（判断不值得回忆是合理产物），不装载种子，仅存在于基准文档。
 */
import type { Memory } from '../src/memory/types.js';
import type { InMemoryStorage } from '../src/memory/inMemoryStorage.js';

/** 单个 case 的种子描述 */
export interface BenchmarkSeed {
  /** 用例编号（A1..A6 / B1..B4） */
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
export const BENCH_SESSION = '2026-09-01-benchmark';
/** round-summary 类用例统一用旧轮（远于 HOT_MEMORY_MAX_ROUNDS 热窗口） */
export const OLD_ROUND = 'r9-bench-seed';

/** 基准内存目标（与基准文档 §2 对应；C 组反例不装载种子） */
export const BENCH_SEEDS: BenchmarkSeed[] = [
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
 * 装载基准种子到隔离会话（只写 InMemoryStorage，不造独立存储实现）。
 * - content/preference：天然不受互斥影响（互斥只滤 round-summary 的 roundId）；
 * - round-summary：用旧轮并放隔离会话，双保险避开 §5.1 组装互斥。
 */
export function loadBenchmarkSeed(storage: InMemoryStorage): void {
  for (const s of BENCH_SEEDS) {
    const base = {
      id: s.expectId,
      name: `${s.id} 种子`,
      content: s.content,
      source: s.source,
    };
    if (s.source === 'round-summary') {
      storage.upsert({ ...base, sessionName: BENCH_SESSION, roundId: OLD_ROUND });
    } else {
      storage.upsert(base);
    }
  }
}