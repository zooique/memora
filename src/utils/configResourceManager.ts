/**
 * 配置资源管理器抽象基类 — 消除 SkillManager / RolePackManager 的重复结构：
 * 扫描 <configDir>/<subdir>/ 的 .md、load/reload/deleteItem 生命周期。
 * 差异化保留在子类（createEntry 条目构造、buildSystemPrompt、各自额外状态/能力）。
 */
import { logger } from '@/logging/logger.js';
import { resolveSubdir, scanMarkdownDir } from '@/utils/scanner.js';
import type { ScannedMarkdownEntry } from '@/utils/scanner.js';

/** 配置资源最小约束 */
export interface ConfigResource {
  name: string;
  content: string;
  filePath: string;
}

/**
 * 配置资源管理器 — 抽象基类
 * @typeParam T 子类资源类型
 * @typeParam TOptions load() 的可选参数类型
 */
export abstract class ConfigResourceManager<T extends ConfigResource, TOptions = undefined> {
  /** 资源列表缓存 */
  protected items: T[] = [];

  /**
   * 运行时注入项的名字集合——「是否有磁盘真理源」必须显式记账，不能从 filePath 反推
   * （注入方 filePath 是约定，可填 '<runtime>'）。registerRuntimeItem() 登记，deleteItem/loadItems 注销。
   */
  private readonly runtimeNames = new Set<string>();

  /**
   * @param configDir 配置目录（资源在 <configDir>/<subdir>/ 下）
   * @param subdir 资源子目录名（如 'skills'、'personas'）
   */
  constructor(
    protected readonly configDir: string | undefined,
    protected readonly subdir: string,
  ) {}

  // ── 公共 API ──────────────────────────────────────────

  /**
   * 资源列表快照——返回浅拷贝而非内部数组引用，
   * 防止外部 push/splice 绕过 register() 的重名校验与 deleteItem() 记账。
   */
  get list(): T[] {
    return [...this.items];
  }

  // ── 受保护的基础设施 ──────────────────────────────────

  /** 加载资源到缓存，items 整体替换、运行时记账作废（子类 load() 中调用） */
  protected async loadItems(options?: TOptions): Promise<number> {
    this.items = await this.scanAndBuild();
    this.runtimeNames.clear();
    this.onAfterLoad(this.items, options);
    logger.info(
      { count: this.items.length, names: this.items.map((i) => i.name), subdir: this.subdir },
      `${this.subdir} 资源加载完成`,
    );
    return this.items.length;
  }

  /**
   * 重载资源——不能整体覆盖 items：那会抹除无磁盘真理源的运行时注入项
   * （如 SkillManager.register 注入的运行时技能，纯内存态、不进记忆库），两侧就此分叉。
   * 判据取 runtimeNames 显式记账；同名冲突以磁盘（更强真理源）为准并注销登记。
   */
  async reload(): Promise<number> {
    const oldCount = this.items.length;
    const scanned = await this.scanAndBuild();
    this.items = this.retainRuntimeItems(scanned);
    this.onAfterReload(this.items);
    logger.info(
      {
        oldCount,
        newCount: this.items.length,
        retainedRuntime: this.items.length - scanned.length,
        subdir: this.subdir,
      },
      `${this.subdir} 资源已重载`,
    );
    return this.items.length;
  }

  /**
   * 子类声明「用户版本覆盖磁盘同名」的条目（默认无）
   *
   * 默认语义 = 磁盘（更强真理源）赢：运行时注入项撞磁盘扫描同名时，磁盘版胜出、
   * 运行时记账注销。SkillManager 的用户技能目录（loadExtraDir）则声明为覆盖——
   * reload 时用户版胜出、记账保留、扫描到的内置版被剔除（见 retainRuntimeItems）。
   * RolePackManager 不覆写，保持默认「磁盘赢」。
   */
  protected isUserOverride(_name: string): boolean {
    return false;
  }

  /**
   * 将磁盘扫描结果与运行时注入项合并（子类自定义扫描的 reload 也应复用本方法）：
   * 重新扫描磁盘后，保留无磁盘真理源的运行时注入项（如 loadExtraDir 注入的用户资源），
   * 同名冲突以磁盘（更强真理源）为准并注销运行时记账——除非子类将同名声明为
   * isUserOverride（用户覆盖内置）：此时用户版保留、记账保留、磁盘版被剔除。
   *
   * @param scanned 本次磁盘扫描得到的资源列表
   * @returns 合并后的完整资源列表（磁盘在前、运行时注入在后）
   */
  protected retainRuntimeItems(scanned: T[]): T[] {
    const scannedNames = new Set(scanned.map((i) => i.name));
    const runtimeInjected = this.items.filter(
      (i) =>
        this.runtimeNames.has(i.name) && (!scannedNames.has(i.name) || this.isUserOverride(i.name)),
    );
    for (const name of this.runtimeNames) {
      // 磁盘同名赢（覆盖项已被保留，见上过滤）→ 注销记账；覆盖项保留记账（下次 reload 仍保留）
      if (scannedNames.has(name) && !this.isUserOverride(name)) this.runtimeNames.delete(name);
    }
    // 覆盖项：剔除本次扫描到的磁盘同名版（用户版保留在后），避免同名双存
    const effectiveScanned = scanned.filter((i) => !this.isUserOverride(i.name));
    return [...effectiveScanned, ...runtimeInjected];
  }

  /** 从内存缓存删除资源（含注销运行时记账） */
  deleteItem(name: string): boolean {
    const idx = this.items.findIndex((i) => i.name === name);
    if (idx < 0) {
      logger.warn({ name, subdir: this.subdir }, '内存缓存中未找到资源，跳过删除');
      return false;
    }
    this.items.splice(idx, 1);
    this.runtimeNames.delete(name);
    logger.info(
      { name, remaining: this.items.length, subdir: this.subdir },
      '资源已从内存缓存删除',
    );
    return true;
  }

  /** 登记运行时注入的资源（子类 register() 唯一落点）——必须记账，
   * 否则 reload() 会把无磁盘真理源的注入项当成"磁盘上已删除"而抹掉。
   * 重名校验由子类调用前完成（各自语义不同）。
   */
  protected registerRuntimeItem(item: T): void {
    this.items.push(item);
    this.runtimeNames.add(item.name);
  }

  /**
   * 运行时注入名单的只读快照（子类对账用，如角色包「重扫用户目录」）。
   * 名单本体保持基类私有单点记账——子类只读快照，禁止外部改写。
   */
  protected get runtimeItemNames(): string[] {
    return [...this.runtimeNames];
  }

  // ── 抽象方法（子类差异化） ──────────────────────────────

  /** 构建 system prompt 片段（name 不传则用当前激活资源） */
  abstract buildSystemPrompt(name?: string): string;

  /** 从扫描条目构建资源对象（子类实现差异化字段解析；返回 null 跳过该条目） */
  protected async createEntry(_entry: ScannedMarkdownEntry): Promise<T | null> {
    // 默认空实现：不解析任何条目，子类可覆写
    return null;
  }

  // ── 生命周期钩子（子类可选覆写） ──────────────────────────

  /** load() 完成后的回调（子类可做激活选择） */
  protected onAfterLoad(_items: T[], _options?: TOptions): void {
    // 默认空实现
  }

  /** reload() 完成后的回调（子类可保持当前激活状态） */
  protected onAfterReload(_items: T[]): void {
    // 默认空实现
  }

  // ── 私有方法 ──────────────────────────────────────────

  /** 扫描目录 + 构建条目列表（按 name 去重） */
  private async scanAndBuild(): Promise<T[]> {
    const map = new Map<string, T>();
    const dir = resolveSubdir(this.configDir, this.subdir);
    if (!dir) return [];

    const entries = await scanMarkdownDir(dir);
    for (const entry of entries) {
      const item = await this.createEntry(entry);
      if (item !== null) {
        map.set(entry.name, item);
      }
    }
    return Array.from(map.values());
  }
}
