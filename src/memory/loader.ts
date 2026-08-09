/**
 * 记忆加载器
 *
 * 职责：把文件系统的记忆（personas/rules/skills）加载到 SQLite 索引
 *       启动时：扫描文件 → 写入索引 → 按 source 召回必召记忆
 *
 * 这是"万物皆记忆"哲学的代码体现——所有记忆共享同一条加载管线
 */
import type { FileStore } from '@/memory/store.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { SOURCE_LABELS, type Memory } from '@/memory/types.js';
import { toError } from '@/utils/toError.js';

/**
 * 启动时全量扫描的 source 列表
 * - insight/profile/work-projection：运行时产生，不由 FileStore 管理
 * - tool：由 registerTool() 注册为 tool_call，不再重复注入 system prompt
 * - guardrail：由 AgentLoop 运行时读取，不注入 system prompt
 */
const STARTUP_SCAN_SOURCES: string[] = [
  SOURCE_LABELS.PERSONA,
  SOURCE_LABELS.RULE,
  SOURCE_LABELS.SKILL,
  SOURCE_LABELS.GUARDRAIL,
];

/**
 * 判断内容是否为空壳模板（仅含标题和 blockquote 占位说明）
 * 新建项目时的空壳规则模板属于此类
 *
 * 判断逻辑：过滤掉标题行和空行后，剩余内容全部是 blockquote 行
 */
function isPlaceholderContent(memory: Memory): boolean {
  const trimmed = memory.content.trim();
  if (trimmed.length > 200) return false;
  const lines = trimmed.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  return lines.length > 0 && lines.every(l => l.trim().startsWith('>'));
}

export interface LoadResult {
  /** 实际加载到索引的记忆数量 */
  loaded: number;
  /** 跳过的记忆（解析失败等） */
  skipped: number;
  /** 加载失败的详情 */
  errors: Array<{ file: string; error: string }>;
  /**
   * 本次加载写入索引的记忆 ID
   *
   * 两个消费者，语义都必须是「已写入索引」：
   *   - `ProjectManager.currentProjectMemoryIds`——关闭项目时撤销哪些记忆；
   *   - `evictOrphanRules` 的存活集——配合 `errors` 判定孤儿（见下方注意）。
   *
   * **不要把它当作「磁盘上还有哪些文件」**。二者在 `errors` 非空时不等：
   * 读取抛错的文件确实存在，但其 id 不可知（`FileStore` 允许 frontmatter 覆盖
   * `${source}:${name}` 默认 id，见 store.ts:211），既进不了本集合也无法从文件名
   * 推导。对账方必须先检查 `errors` 为空才可使用本集合做差集。
   */
  loadedIds?: string[];
}

export class MemoryLoader {
  constructor(
    private readonly fileStore: FileStore,
    private readonly index: IMemoryStorage,
  ) {}

  /**
   * 扫描所有"配置类"记忆文件（persona/rule/skill）
   * 写入 SQLite 索引
   *
   * @returns 加载结果统计
   */
  async loadAllToIndex(): Promise<LoadResult> {
    const result: LoadResult = { loaded: 0, skipped: 0, errors: [], loadedIds: [] };

    for (const source of STARTUP_SCAN_SOURCES) {
      const names = await this.fileStore.list(source);
      for (const name of names) {
        try {
          const memory = await this.fileStore.read(source, name);
          if (!memory) {
            // read 返回 null 仅在 ENOENT——list 到 read 之间文件被删。
            // 此时「无文件支撑」为真，不进 loadedIds 正是对账想要的结果。
            result.skipped++;
            continue;
          }
          // 跳过空壳模板（新建项目时的占位文件，无实质规则内容）
          // 不进 loadedIds 亦为正确：文件内容已被清空成占位，索引里的旧内容是陈旧副本，
          // 交由对账软删除，避免「用户看文件已清空、system prompt 仍在注入旧规则」。
          if (isPlaceholderContent(memory)) {
            result.skipped++;
            continue;
          }
          // 从磁盘重新加载 = 以文件为权威源恢复记忆。若此前该记忆已被软删除
          // （如 closeProject 撤销项目记忆），必须先 restore 再 upsert——
          // IMemoryStorage.upsert 明确禁止「以活跃态覆盖软删除态」复活，
          // 否则 closeProject 后重新打开同一项目时记忆会因 upsert 抛错被静默跳过而永久丢失。
          // restore 对活跃/不存在记忆为 no-op，不影响正常加载路径。
          this.index.restore(memory.id);
          this.index.upsert(memory);
          result.loaded++;
          result.loadedIds!.push(memory.id);
        } catch (err) {
          // 读取抛错（EACCES/EISDIR 等）：文件存在，但 id 不可知（frontmatter 可覆盖
          // 默认 id，读不到就无从得知）。该条目既进不了 loadedIds，也无法被单独豁免
          // ——只能由 errors 非空让下游 evictOrphanRules 整体停用对账，
          // 避免把「暂时读不到」误判成「文件已删除」而软删用户的规则。
          result.skipped++;
          result.errors.push({
            file: `${source}/${name}`,
            error: toError(err).message,
          });
        }
      }
    }

    return result;
  }

  /**
   * 启动时的完整引导流程
   * 1. 扫描配置文件 → 写入索引
   * 2. 从索引按 source 召回必召记忆（rule + skill）
   *
   * 注：persona 记忆由 PersonaManager 单独处理，
   * bootstrap 中自动跳过 persona（避免与 systemPromptPrefix 中的角色 prompt 重复）。
   *
   * @returns 启动时必召的所有记忆（用于初始化 Agent Loop 的 system prompt）
   */
  async bootstrap(): Promise<{ memories: Memory[]; loadResult: LoadResult }> {
    const loadResult = await this.loadAllToIndex();
    // 按 source 获取 rule 和 skill 记忆（跳过 persona，由 PersonaManager 单独管理）
    const rules = this.index.getBySource(SOURCE_LABELS.RULE);
    const skills = this.index.getBySource(SOURCE_LABELS.SKILL);
    const memories = [...rules, ...skills];
    return {
      memories,
      loadResult,
    };
  }
}
