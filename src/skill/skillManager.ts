/**
 * 技能管理器 — 单层目录扫描 + 关键词匹配
 *
 * 职责：
 *   - 启动时扫描 configDir/skills/ 目录
 *   - 通过关键词匹配选择技能（初期阶段一/二）
 *   - 写入 SQLite 索引（source: skill，遵循"万物皆记忆"）
 *   - 后期触发条件（≥15个技能 / 关键词命中率 <80%）→ 切换为 LLM 自主选择
 *
 * 设计原则（ADR-004 万物皆记忆）：
 *   - 技能遵循"万物皆记忆"——存入 SQLite 作为 skill 来源记忆
 *   - 单层目录：<configDir>/skills/（宿主负责汇总全局+项目级技能到 configDir）
 *   - 与 PersonaManager 存储策略一致：文件加载 → 内存缓存 + SQLite 索引
 *
 * 触发词说明：
 *   每个 skill 文件的 frontmatter 声明 keywords（逗号分隔）和 trigger（触发正则，可选）。
 *   skill 文件命名规范：`<技能名>.md`（如"去AI味.md""审视角.md""写代码.md"）。
 */
import { scoreByKeywords } from '@/utils/segmenter.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Memory } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';
import { byScoreDesc } from '@/utils/array.js';
import { configError } from '@/utils/errors.js';
import type { SkillEntry, SkillMatch } from '@/skill/types.js';
import { nowIso } from '@/utils/time.js';
import { scanMarkdownDir, parseKeywords, parseTrigger, resolveSubdir } from '@/utils/scanner.js';

/**
 * 技能管理器
 */
export class SkillManager {
  /** 技能列表缓存（启动时扫描一次） */
  private skills: SkillEntry[] = [];

  /**
   * @param configDir 配置目录（技能文件在 <configDir>/skills/ 下）
   * @param index SQLite 索引（用于写入 skill 记忆）
   */
  constructor(
    private readonly configDir?: string,
    private readonly index?: IMemoryStorage,
  ) {}

  /**
   * 启动时加载：扫描技能目录
   *
   * @returns 加载的技能数量
   */
  async load(): Promise<number> {
    this.skills = await this.scanSkills();
    logger.info(
      { count: this.skills.length, names: this.skills.map((s) => s.name) },
      '技能加载完成',
    );

    // 写入 SQLite 索引（遵循"万物皆记忆"——与 PersonaManager 一致）
    this.writeAllToIndex();

    return this.skills.length;
  }

  /**
   * 根据用户输入匹配最合适的技能
   *
   * 匹配流程：
   *   1. 先检查所有 trigger 正则，命中直接返回（最高优先级）
   *   2. 再检查关键词匹配（TF 计分，得分排序）
   *   3. 若匹配多项但得分相同 → 取第一个
   *   4. 无任何匹配 → 返回 null
   *
   * @param userInput 用户输入文本
   * @returns 匹配结果，无匹配返回 null
   */
  match(userInput: string): SkillMatch | null {
    if (this.skills.length === 0) return null;

    // 1. trigger 正则匹配（最高优先级）
    for (const skill of this.skills) {
      if (skill.trigger?.test(userInput)) {
        logger.debug({ skill: skill.name, trigger: skill.trigger.source }, '技能触发器匹配');
        return { skill, score: 1.0 };
      }
    }

    const matches: SkillMatch[] = [];

    for (const skill of this.skills) {
      if (skill.keywords.length === 0) continue;

      const score = scoreByKeywords(userInput, skill.keywords);
      if (score > 0) {
        matches.push({ skill, score });
      }
    }

    if (matches.length === 0) return null;

    // 得分从高到低排序，取第一个
    matches.sort(byScoreDesc);
    const best = matches[0];
    if (!best) return null;
    logger.debug({ matched: best.skill.name, score: best.score }, '技能关键词匹配');
    return best;
  }

  /**
   * 根据技能名获取技能
   *
   * @param name 技能名
   * @returns 技能条目，不存在返回 null
   */
  get(name: string): SkillEntry | null {
    return this.skills.find((s) => s.name === name) ?? null;
  }

  /**
   * 获取所有技能列表
   */
  get list(): SkillEntry[] {
    return this.skills;
  }

  /**
   * 注册运行时注入的技能
   *
   * 供 Agent.addSkill() 调用：宿主程序可在 init() 之后动态注入技能。
   * 重复注册同名技能会被拒绝（与文件加载的技能冲突时也按"先到先得"判断）。
   *
   * @param skill 技能条目
   * @throws 技能名已存在时抛错
   */
  register(skill: SkillEntry): void {
    if (this.skills.some((s) => s.name === skill.name)) {
      throw configError(
        `技能 "${skill.name}" 已存在，不能重复注册`,
        undefined,
        ['请使用不同的技能名称'],
      );
    }
    this.skills.push(skill);
    logger.info({ name: skill.name, keywords: skill.keywords.length }, '技能已注册（运行时注入）');
  }

  /**
   * 重载技能：清空内存缓存 + 重新扫描目录 + 同步 SQLite 索引
   *
   * 事件驱动重载：installSkill 写入文件后或用户手动编辑 skills/ 目录后，
   * 调用此方法使当前会话立即生效，无需重启 Agent。
   *
   * 与 load() 的区别：
   * - load() → 启动时首次加载（冷启动）
   * - reload() → 运行时增量重载（热更新），保留运行时 register() 注入的技能会被覆盖
   *
   * @returns 重载后的技能数量
   */
  async reload(): Promise<number> {
    const oldCount = this.skills.length;
    this.skills = await this.scanSkills();
    this.writeAllToIndex();
    logger.info(
      { oldCount, newCount: this.skills.length, names: this.skills.map((s) => s.name) },
      '技能已重载',
    );
    return this.skills.length;
  }

  /**
   * 构建 system prompt 中的技能段
   *
   * 格式：
   *   【当前技能】技能名
   *   技能 prompt 正文...
   *
   * @param name 技能名（可选，不传返回空）
   */
  buildSystemPrompt(name?: string): string {
    if (!name) return '';
    const skill = this.get(name);
    if (!skill) return '';

    return `【当前技能】${skill.name}\n${skill.content}`;
  }

  // ── 私有方法 ──────────────────────────────────────

  /**
   * 将所有技能写入 SQLite 索引
   *
   * 本函数循环体内无 await，作为同步函数实现（与 personaManager.writeAllToIndex 同模式）。
   */
  private writeAllToIndex(): void {
    if (!this.index) return;
    for (const skill of this.skills) {
      this.writeSkillToIndex(skill);
    }
    logger.info({ count: this.skills.length }, '技能记忆已写入 SQLite');
  }

  /**
   * 将单个技能写入 SQLite 索引
   */
  private writeSkillToIndex(skill: SkillEntry): void {
    if (!this.index) return;
    const now = nowIso();
    const memory: Memory = {
      id: `skill:${skill.name}`,
      content: skill.content,
      source: SOURCE_LABELS.SKILL,
      name: skill.name,
      createdAt: now,
      accessedAt: now,
      score: 0.7,
    };
    this.index.upsert(memory);
  }

  /**
   * 扫描 configDir/skills/ 目录
   *
   * 宿主负责将全局+项目级技能汇总到 configDir，
   * 内核只扫描一个目录，不做路径假设。
   */
  private async scanSkills(): Promise<SkillEntry[]> {
    const map = new Map<string, SkillEntry>();

    const skillsDir = resolveSubdir(this.configDir, 'skills');
    if (skillsDir) {
      const entries = await scanMarkdownDir(skillsDir);
      for (const entry of entries) {
        const skill: SkillEntry = {
          name: entry.name,
          keywords: parseKeywords(entry.frontmatter),
          trigger: parseTrigger(entry.frontmatter),
          description: entry.frontmatter['description'],
          content: entry.body.trim(),
          filePath: entry.filePath,
          layer: 'project',
        };
        map.set(entry.name, skill);
      }
    }

    return Array.from(map.values());
  }

}
