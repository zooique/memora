/**
 * 取代状态判定 —— supersede 悬空指针的消费侧单一判据。
 *
 * 背景（写时取代模型，见 roundSummaryGenerator / ADR-021）：
 *   - 同 session 内新摘要生成时，若与近窗口旧摘要主题重叠（加权 Jaccard ≥ 阈值），
 *     给旧摘要打 `supersededBy = 新摘要.id`（软指针，非删除，保留可回溯）。
 *   - 消费侧（内核召回过滤 searchByKeyword、取代候选 getSessionCandidates、宿主治理展示）
 *     据此把「被取代者」视为非当前版本。
 *
 * 缺口（设计边界）：`supersededBy` 指向的「替代物摘要」可能被移除——GC purge、宿主软删/
 * 物理删/过期清理、去重降级，任一路径都会使旧摘要的指针悬空。此时旧摘要既被消费侧过滤、
 * 又无「当前版本」可取 → 有效记忆静默不可召回。
 *
 * 修法（SSOT）：悬空指针的本质是「指向不存在/非活跃的记忆」。把这一判定收口成单一判据，
 * 所有消费 supersededBy 的位置统一经此判定——与「谁、用哪条路径移除了替代物」完全解耦：
 * 任一移除入口（含未来的新入口）都自动覆盖，无需在每个移除点补收敛逻辑（避免「漏接一处
 * 即漏一类」）。判据语义：
 *   - 指针指向现存且活跃的记忆 → 真取代（隐藏旧、显新）。
 *   - 指针悬空（目标被移除或软删） → 视为未取代（旧摘要回退为当前版本，可召回、可再被取代）。
 *
 * 单端口原则：只读经 `getById` 契约暴露的存在性（不写入、不引入新机制）。
 */
import type { Memory } from '@/memory/types.js';

/**
 * 记忆是否被「现存且活跃」的摘要取代。
 *
 * 仅当 `supersededBy` 非空且其目标当前存在且活跃时返回 `true`；指针悬空（目标已移除/软删）
 * 返回 `false`（该记忆回退为当前版本）。
 *
 * @param memory 待判定的记忆（只需 `supersededBy` 字段，兼容内核 `Memory` 与宿主 DTO 输入）
 * @param lookup 存在性查询（`IMemoryStorage` 与内核 `MemoryInspector` 均满足 `{ getById }`）
 * @returns 是否被现存活跃摘要取代
 */
export function hasActiveSuperseder(
  memory: { supersededBy?: string },
  lookup: { getById(id: string): Memory | null },
): boolean {
  if (memory.supersededBy === undefined) return false;
  return lookup.getById(memory.supersededBy) !== null;
}
