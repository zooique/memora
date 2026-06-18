/**
 * 记忆加载器
 *
 * 职责：把文件系统的记忆（personas/rules/skills）加载到 SQLite 索引
 *       启动时：扫描文件 → 写入索引 → 按 source 召回必召记忆
 *
 * 这是"万物皆记忆"哲学的代码体现——所有记忆共享同一条加载管线
 */
import type { FileStore } from './store.js';
import type { IMemoryStorage } from './storageInterface.js';
import { SOURCE_LABELS, type Memory } from './types.js';
import { toError } from '@/utils/errors.js';

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
 * 新建项目时 .memora/rules/ 下的 character/worldview/foreshadow 模板属于此类
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
    const result: LoadResult = { loaded: 0, skipped: 0, errors: [] };

    for (const source of STARTUP_SCAN_SOURCES) {
      const names = await this.fileStore.list(source);
      for (const name of names) {
        try {
          const memory = await this.fileStore.read(source, name);
          if (!memory) {
            result.skipped++;
            continue;
          }
          // 跳过空壳模板（新建项目时的占位文件，无实质规则内容）
          if (isPlaceholderContent(memory)) {
            result.skipped++;
            continue;
          }
          this.index.upsert(memory);
          result.loaded++;
        } catch (err) {
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
