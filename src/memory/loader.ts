/**
 * 记忆加载器
 *
 * 职责：把文件系统的记忆（personality/rules/skills/tools）加载到 SQLite 索引
 *       启动时：扫描文件 → 写入索引 → 读 always+domain 必召记忆
 *
 * 这是"万物皆记忆"哲学的代码体现——所有记忆类型共享同一条加载管线
 * 详见 ADR-004 · 记忆统一为"类型 + 永久性标记"模型
 */
import type { FileStore } from './store.js';
import type { IMemoryStorage } from './storage-interface.js';
import { MemoryType, type Memory, type MemoryTypeValue } from './types.js';

/**
 * 不应在启动时全量扫描的类型
 * - topic：每次对话都会产生，不应该"启动时全量加载"
 * - archive：已归档的记忆，按需召回即可
 */
const STARTUP_SCAN_TYPES: MemoryTypeValue[] = [
  MemoryType.PERSONALITY,
  MemoryType.RULE,
  MemoryType.SKILL,
  MemoryType.TOOL,
];

export interface LoadResult {
  /** 实际加载到索引的记忆数量 */
  loaded: number;
  /** 跳过的记忆（解析失败等） */
  skipped: number;
  /** 加载失败的详情 */
  errors: Array<{ file: string; error: string }>;
}

export class MemoryLoader {
  constructor(
    private readonly fileStore: FileStore,
    private readonly index: IMemoryStorage,
  ) {}

  /**
   * 扫描所有"配置类"记忆文件（personality/rules/skills/tools）
   * 写入 SQLite 索引
   *
   * @returns 加载结果统计
   */
  async loadAllToIndex(): Promise<LoadResult> {
    const result: LoadResult = { loaded: 0, skipped: 0, errors: [] };

    for (const type of STARTUP_SCAN_TYPES) {
      const names = await this.fileStore.list(type);
      for (const name of names) {
        try {
          const memory = await this.fileStore.read(type, name);
          if (!memory) {
            result.skipped++;
            continue;
          }
          await this.index.upsert(memory);
          result.loaded++;
        } catch (err) {
          result.skipped++;
          result.errors.push({
            file: `${type}/${name}`,
            error: (err as Error).message,
          });
        }
      }
    }

    return result;
  }

  /**
   * 启动时的完整引导流程
   * 1. 扫描配置文件 → 写入索引
   * 2. 从索引读 always + domain 必召记忆
   *
   * 注：personality 类型记忆由 PersonaManager 单独处理，
   * bootstrap 中自动跳过 personality（避免与 systemPromptPrefix 中的角色 prompt 重复）。
   *
   * @returns 启动时必召的所有记忆（用于初始化 Agent Loop 的 system prompt）
   */
  async bootstrap(): Promise<{ memories: Memory[]; loadResult: LoadResult }> {
    const loadResult = await this.loadAllToIndex();
    const always = await this.index.getByPermanence('always');
    // 跳过 personality 类型——PersonaManager 单独管理角色注入
    const nonPersonality = always.filter((m) => m.type !== MemoryType.PERSONALITY);
    const domain = await this.index.getByPermanence('domain');
    const memories = [...nonPersonality, ...domain].filter(Boolean) as Memory[];
    return {
      memories,
      loadResult,
    };
  }
}
