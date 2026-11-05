/**
 * 内存问答闭环存储实现 — IRoundStore 的纯 JS 内存版
 *
 * 设计理念：
 * - 零依赖零 IO，用于单元测试、临时占位
 * - 不持久化（进程退出即丢失），仅限测试/开发
 * - 生产由宿主注入持久化实现（FileRoundStore 或宿主自选后端）
 */

import type { Round, RoundStatus, IRoundStore } from '@/memory/roundStore.js';
import { isWithinLocalDay } from '@/utils/time.js';

/**
 * 内存问答闭环存储
 *
 * 核心实现：
 * - Map 存储（id → Round）
 * - **引用真源由会话侧注入**（`referencedIdsProvider`）——`Round.refCount` 不是真源
 * - 支持批量获取（getByIds）
 * - 支持按状态筛选（listByStatus）
 * - 支持孤立检查（listOrphaned）
 */
export class InMemoryRoundStore implements IRoundStore {
  /** Round 存储（id → Round） */
  private rounds: Map<string, Round> = new Map();
  /**
   * 引用真源提供者（由 `InMemorySessionStore` 构造时注入）
   *
   * 内存存储本身不持有会话，只能靠会话侧给出「当前被引用的 Round ID 集合」；
   * 未注入时 `listOrphaned` 返回空（宁可不回收，也不读过期 `refCount` 误删）。
   */
  private referencedIdsProvider: (() => ReadonlySet<string>) | null = null;

  /**
   * 注入引用真源（引用真源 = 会话 roundIds，单一来源）
   *
   * @param provider - 返回当前被任意会话引用的 Round ID 集合
   */
  setReferencedIdsProvider(provider: () => ReadonlySet<string>): void {
    this.referencedIdsProvider = provider;
  }

  /**
   * 存储问答闭环（新增或更新）
   *
   * @param round - 问答闭环对象
   */
  save(round: Round): void {
    // 浅拷贝，防止外部修改影响内部状态
    this.rounds.set(round.id, { ...round });
  }

  /**
   * 按 ID 获取问答闭环
   *
   * @param roundId - 全局唯一 Round ID
   * @returns Round 对象，不存在返回 null
   */
  getById(roundId: string): Round | null {
    const round = this.rounds.get(roundId);
    if (!round) return null;
    return { ...round };
  }

  /**
   * 批量获取问答闭环
   *
   * 不存在的 ID 会被跳过，不报错
   *
   * @param roundIds - Round ID 数组
   * @returns Round 对象数组（按输入顺序，跳过不存在的）
   */
  getByIds(roundIds: string[]): Round[] {
    const results: Round[] = [];
    for (const id of roundIds) {
      const round = this.rounds.get(id);
      if (round) {
        results.push({ ...round });
      }
    }
    return results;
  }

  /**
   * 列出所有问答闭环
   *
   * ⚠️ 生产环境慎用：全量遍历可能性能开销大
   *
   * @returns 所有 Round 数组（浅拷贝）
   */
  listAll(): Round[] {
    return Array.from(this.rounds.values()).map((r) => ({ ...r }));
  }

  /**
   * 增加引用计数（**no-op**：引用真源 = 会话 roundIds）
   *
   * 保留 API 仅供公开面兼容（7.0.0 移除）；调用不产生任何状态变化。
   *
   * @param roundId - 需要增加引用的 Round ID
   */
  incrementRef(_roundId: string): void {
    // 有意为空：分叉只复制会话 roundIds 指针，不触碰轮次数据
  }

  /**
   * 减少引用计数（**no-op**：引用真源 = 会话 roundIds）
   *
   * 保留 API 仅供公开面兼容（7.0.0 移除）；调用不产生任何状态变化。
   *
   * @param roundId - 需要减少引用的 Round ID
   */
  decrementRef(_roundId: string): void {
    // 有意为空：删除会话 / 截断先收缩 roundIds，再由会话侧现场派生死
  }

  /**
   * 删除问答闭环（物理删除，不可恢复）
   *
   * 🔴 无 `refCount` 前置条件：调用方须先确认该轮已不在任何会话 roundIds 中。
   *
   * @param roundId - 要删除的 Round ID
   * @returns 是否删除成功（不存在时返回 false）
   */
  delete(roundId: string): boolean {
    if (!this.rounds.has(roundId)) return false;
    this.rounds.delete(roundId);
    return true;
  }

  /**
   * 按状态列出问答闭环
   *
   * @param status - Round 状态筛选
   * @returns 符合条件的 Round 数组
   */
  listByStatus(status: RoundStatus): Round[] {
    return Array.from(this.rounds.values())
      .filter((r) => r.status === status)
      .map((r) => ({ ...r }));
  }

  /**
   * 获取孤立的问答闭环列表
   *
   * 判据 = **不在任何会话 roundIds 中** + `createdAt` 超龄（引用集合由会话侧现场注入）。
   * 未注入引用真源时返回空数组——宁可不回收，也不按过期 `refCount` 误删。
   *
   * @param minAgeMs - 最小存活时间（毫秒）：给「刚失去引用」的轮留后悔窗口
   * @returns 孤立 Round 数组
   */
  listOrphaned(minAgeMs: number = 0): Round[] {
    const referenced = this.referencedIdsProvider?.();
    if (!referenced) return [];

    const now = Date.now();
    return Array.from(this.rounds.values())
      .filter((r) => !referenced.has(r.id))
      .filter((r) => now - new Date(r.createdAt).getTime() >= minAgeMs)
      .map((r) => ({ ...r }));
  }

  /**
   * 列出指定日期最近未完成（pending/error）的崩溃残留轮（step 原子落盘）。
   *
   * 崩溃发生在 appendAssistant 前时，该轮 refCount=0、未登记会话、orphan 但可能有已落盘
   * processEvents（step 检查点）。宿主重启后经此口「找到」中断轮，再调收场方法
   * （MessageHistory.appendInterrupted）**升级为正常 stop turn**（非半成品草稿）。
   * 只读、不改写、不登记会话；升级完成（complete + refCount>0）前为打捞窗口内中间态，
   * 超龄仍未升级的中断轮由 GC 回收（默认 24h 存活保护覆盖打捞窗口，不误回收）。
   *
   * @param date - YYYY-MM-DD **本地日期**（与会话 ID 日期同口径）：按本地日区间
   *   `[D 00:00, D+1 00:00)` 换算 UTC 后比较 createdAt——判据单点 = `isWithinLocalDay`，
   *   与宿主 `WorkspaceRoundStore` 同源（前缀匹配在 UTC+8 凌晨窗口漏捞，E2E-TZ-SALVAGE-1）
   * @param limit - 最多条数，按 createdAt 降序（最新在前）；缺省不截断
   * @returns 中断残留 Round 数组（倒序）
   */
  listInterruptedRecent(date: string, limit?: number): Round[] {
    // 崩溃残留轮 = **未收场**（pending/error），按本地日区间过滤后倒序取最新
    //
    // ⚠️ `'error'` 是**预留态**（明示收起）：
    // 全仓**无任何写点**把 Round.status 置为 'error'（写点仅 pending → complete /
    // appendInterrupted → interrupted，中断轮不伪 complete）——它在此处与
    // 'pending' **共用同一条打捞条件**，故保留字段本身零成本、删除反而是无谓改动。
    // 保留的是「接口形状」而非「当前行为」：若未来出现「整轮失败且需与中断区分」的
    // 真实需求，可在此分支补齐语义，无需改签名。
    // ⚠️ `interrupted` **不入本打捞口**：它已是「已收场的停 turn」，不属崩溃残留。
    // 纪律：勿因「grep 到零写点」而删该字段（它是打捞条件的组成部分，非死代码）。
    //
    // 🔴 ADR-044：判据**不再含 `refCount === 0`**（与宿主 `workspaceRoundStore` 同款改动）。
    // 建轮即 refCount 1，沿用旧判据会让崩溃残留轮永远捞不到 ⇒ 跨重启恢复失效。
    const interrupted = Array.from(this.rounds.values())
      .filter((r) => r.status === 'pending' || r.status === 'error')
      .filter((r) => isWithinLocalDay(r.createdAt, date))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return (limit !== undefined ? interrupted.slice(0, limit) : interrupted).map((r) => ({ ...r }));
  }

  /**
   * 获取存储中的 Round 数量
   *
   * 用于监控和测试
   *
   * @returns Round 总数
   */
  size(): number {
    return this.rounds.size;
  }

  /**
   * 清空存储（测试用）
   *
   * ⚠️ 不可逆操作，仅用于测试
   */
  clear(): void {
    this.rounds.clear();
  }
}
