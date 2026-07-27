/**
 * 配置资源管理器抽象基类 — 消除 SkillManager 与 PersonaManager 的重复结构
 *
 * 共同模式（DRY）：
 *   - 扫描 configDir/<subdir>/ 中的 .md 文件
 *   - 解析 frontmatter keywords
 *   - scoreByKeywords 关键词匹配
 *   - load → reload → deleteItem 生命周期
 *
 * 分叉点（子类差异化）：
 *   - createEntry() → 条目构造（Persona 需要 traits 解析，Skill 需要 layer/trigger）
 *   - buildSystemPrompt() → 系统提示格式
 *   - PersonaManager 额外状态：activePersona / mode / 切换缓冲 → 保留在子类
 *   - SkillManager 额外能力：trigger 正则匹配 / register() → 保留在子类
 *
 * 抽象收益验证（§2.2 技术债务的阈值判断）：
 *   - 2 个使用场景，领域规则大概率会变 → 抽象收益 > 复制成本
 *   - 扫描 + 匹配 + 生命周期共 ~60 行重复 → 消除后的维护成本显著降低
 *
 * 复杂度控制（§1.3）：
 *   - 泛型参数 T 由子类具体化，基类不假设 T 的具体形状
 *   - 基类只提供公共基础设施，不引入新概念
 */

import { scoreByKeywords } from '@/utils/segmenter.js';
import { logger } from '@/logging/logger.js';
import { resolveSubdir, scanMarkdownDir } from '@/utils/scanner.js';
import type { ScannedMarkdownEntry } from '@/utils/scanner.js';

/**
 * 配置资源的最小约束：必须有 name、keywords、content、filePath
 */
export interface ConfigResource {
  name: string;
  keywords: string[];
  content: string;
  filePath: string;
}

/**
 * 配置资源管理器 — 抽象基类
 *
 * @typeParam T 子类资源类型（如 Persona / SkillEntry）
 * @typeParam TOptions load() 的可选参数类型
 */
export abstract class ConfigResourceManager<
  T extends ConfigResource,
  TOptions = undefined,
> {
  /** 资源列表缓存 */
  protected items: T[] = [];

  /**
   * @param configDir 配置目录（资源文件在 <configDir>/<subdir>/ 下）
   * @param subdir 资源子目录名（如 'skills'、'personas'）
   */
  constructor(
    protected readonly configDir: string | undefined,
    protected readonly subdir: string,
  ) {}

  // ── 公共 API ──────────────────────────────────────────

  /** 获取资源列表 */
  get list(): T[] {
    return this.items;
  }

  // ── 受保护的基础设施（子类调用） ─────────────────────────

  /**
   * 加载资源到缓存（子类在各自的 load() 中调用）
   *
   * @param options 子类透传参数
   * @returns 加载的资源数量
   */
  protected async loadItems(options?: TOptions): Promise<number> {
    this.items = await this.scanAndBuild();
    this.onAfterLoad(this.items, options);
    logger.info(
      { count: this.items.length, names: this.items.map((i) => i.name), subdir: this.subdir },
      `${this.subdir} 资源加载完成`,
    );
    return this.items.length;
  }

  /**
   * 重载资源：重新扫描目录 → 更新缓存
   *
   * @returns 重载后的资源数量
   */
  async reload(): Promise<number> {
    const oldCount = this.items.length;
    this.items = await this.scanAndBuild();
    this.onAfterReload(this.items);
    logger.info(
      { oldCount, newCount: this.items.length, subdir: this.subdir },
      `${this.subdir} 资源已重载`,
    );
    return this.items.length;
  }

  /**
   * 删除资源（从内存缓存中移除）
   *
   * @param name 资源名
   * @returns true 删除成功；false 资源不存在
   */
  deleteItem(name: string): boolean {
    const idx = this.items.findIndex((i) => i.name === name);
    if (idx < 0) {
      logger.warn({ name, subdir: this.subdir }, '内存缓存中未找到资源，跳过删除');
      return false;
    }
    this.items.splice(idx, 1);
    logger.info({ name, remaining: this.items.length, subdir: this.subdir }, '资源已从内存缓存删除');
    return true;
  }

  // ── 关键词匹配（共享实现） ──────────────────────────────

  /**
   * 关键词匹配：遍历资源列表，返回得分最高的资源
   *
   * 子类可覆写此方法以添加额外匹配逻辑（如 trigger 正则匹配）。
   *
   * @param userInput 用户输入文本
   * @param threshold 最低激活阈值（低于此值的匹配忽略）
   * @returns 匹配结果（资源 + 得分），无匹配返回 null
   */
  protected findBestKeywordMatch(
    userInput: string,
    threshold: number,
  ): { item: T; score: number } | null {
    const matches: Array<{ item: T; score: number }> = [];

    for (const item of this.items) {
      if (item.keywords.length === 0) continue;
      const score = scoreByKeywords(userInput, item.keywords);
      if (score >= threshold) {
        matches.push({ item, score });
      }
    }

    if (matches.length === 0) return null;

    // 主排序：得分降序；次排序：name 字母序（保证同分时确定性）
    matches.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return matches[0] ?? null;
  }

  // ── 抽象方法（子类差异化） ──────────────────────────────

  /**
   * 构建 system prompt 片段
   *
   * @param name 资源名（可选，不传使用当前激活资源）
   */
  abstract buildSystemPrompt(name?: string): string;

  /**
   * 从扫描条目构建资源对象（子类实现差异化字段解析）
   *
   * @param entry 扫描器返回的原始条目
   * @returns 子类资源类型
   */
  protected abstract createEntry(entry: ScannedMarkdownEntry): T;

  // ── 生命周期钩子（子类可选覆写） ──────────────────────────

  /**
   * load() 完成后的回调 — 子类可在此做激活选择等逻辑
   */
  protected onAfterLoad(_items: T[], _options?: TOptions): void {
    // 默认空实现
  }

  /**
   * reload() 完成后的回调 — 子类可在此保持当前激活状态
   */
  protected onAfterReload(_items: T[]): void {
    // 默认空实现
  }

  // ── 私有方法 ──────────────────────────────────────────

  /**
   * 扫描目录 + 构建条目列表
   */
  private async scanAndBuild(): Promise<T[]> {
    const map = new Map<string, T>();
    const dir = resolveSubdir(this.configDir, this.subdir);
    if (!dir) return [];

    const entries = await scanMarkdownDir(dir);
    for (const entry of entries) {
      const item = this.createEntry(entry);
      map.set(entry.name, item);
    }
    return Array.from(map.values());
  }
}
