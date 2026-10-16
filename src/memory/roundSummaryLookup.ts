/**
 * round-summary 派生寻址 —— 按 roundId 反查派生摘要（单一真理源）
 *
 * 定案（memory-as-summary.md §5.1）：Round 是物理唯一真理源，round-summary 按
 * `roundId` 顶层字段溯源，Round 侧不持有反向指针 ⇒「Round 退出 → 派生摘要处置」
 * 的**选择集**只在本文件定义一次，两条消费路径共用：
 *   - 宿主联动（删会话/回溯截断/孤儿清扫）→ MemoryInspector.softDeleteRoundSummaries（软删 + 脱钩溯源，可恢复）
 *   - 内核 GC（孤儿轮引用归零）→ GCService.cleanUpRoundSummary（物理 purge，系统治理决定）
 * ⚠️ 只共用「选哪些」；「怎么处置」（软删 vs purge）分叉是有意语义，勿折叠（见 §5.1 删除规则表）。
 *
 * 依赖方向：本文件在 memory/ 层，仅类型 import，agent/managers 与 memory 内部均可单向消费。
 */
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';

/**
 * 按 roundId 集合反查活跃 round-summary（覆盖全部会话命名空间的两段式 ID）
 *
 * 两段式摘要 ID `round-summary:{sessionName}:{roundId}` 含会话段，同轮可能被多会话
 * 引用 —— 故按顶层 roundId 字段寻址，不解析 ID 字符串。
 *
 * @param storage 记忆库（两条路径各自持有，本函数只读不写）
 * @param roundIds 目标轮次 ID 集合（单轮场景传单元素集合）
 * @returns 命中的活跃摘要（仅内存活跃面；软删摘要不在其中，语义见 IMemoryStorage.getBySource）
 */
export function findRoundSummaries(
  storage: IMemoryStorage,
  roundIds: ReadonlySet<string>,
): Memory[] {
  if (roundIds.size === 0) return [];
  return storage
    .getBySource(SOURCE_LABELS.ROUND_SUMMARY)
    .filter((m) => m.roundId !== undefined && roundIds.has(m.roundId));
}
