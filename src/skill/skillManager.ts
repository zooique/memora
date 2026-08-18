/**
 * 技能管理器 — 继承 ConfigResourceManager，扩展 trigger 正则匹配 + 运行时注册
 *
 * 职责：
 *   - 启动时扫描 configDir/skills/ 目录
 *   - 通过关键词匹配 + trigger 正则选择技能
 *   - 支持运行时 register() 注入技能
 *   - 三级渐进披露：L1 元数据常驻 / L2 read_skill 按需 / L3 resources+scripts
 *
 * 设计原则：
 *   - 单层目录：<configDir>/skills/（宿主负责汇总全局+项目级技能到 configDir）
 *   - 与 RolePackManager 共享 ConfigResourceManager 基类（消除重复扫描/匹配/生命周期）
 *
 * 触发词说明：
 *   每个 skill 文件的 frontmatter 声明 keywords（逗号分隔）和 trigger（触发正则，可选）。
 *   skill 文件命名规范：`<技能名>.md`（如"去AI味.md""审视角.md""写代码.md"）。
 */
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import type { SkillEntry, SkillMatch, SkillLayer3 } from '@/skill/types.js';
import { parseTrigger, parseKeywords, discoverLayer3 } from '@/utils/scanner.js';
import type { ScannedMarkdownEntry } from '@/utils/scanner.js';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/**
 * 技能匹配最低激活阈值
 *
 * score < 此阈值的匹配不激活技能（避免低匹配度噪音）。
 * 与 PersonaManager 的 KEYWORD_HIGH_CONFIDENCE_THRESHOLD (0.3) 一致。
 */
const SKILL_MATCH_MIN_SCORE = 0.3;

/**
 * 技能管理器
 */
export class SkillManager extends ConfigResourceManager<SkillEntry> {
  /**
   * @param configDir 配置目录（技能文件在 <configDir>/skills/ 下）
   */
  constructor(configDir?: string) {
    super(configDir, 'skills');
  }

  // ── 生命周期 ──────────────────────────────────────

  /**
   * 启动时加载：扫描技能目录
   *
   * @returns 加载的技能数量
   */
  async load(): Promise<number> {
    return this.loadItems();
  }

  /**
   * 根据用户输入匹配最合适的技能
   *
   * 匹配流程：
   *   1. 先检查所有 trigger 正则，命中直接返回（最高优先级，score=1.0）
   *   2. 再检查关键词匹配（复用基类 findBestKeywordMatch）
   *   3. 关键词得分 < SKILL_MATCH_MIN_SCORE 的匹配不激活
   *
   * @param userInput 用户输入文本
   * @returns 匹配结果，无匹配返回 null
   */
  match(userInput: string): SkillMatch | null {
    if (this.items.length === 0) return null;

    // 1. trigger 正则匹配（最高优先级）
    for (const skill of this.items) {
      if (skill.trigger?.test(userInput)) {
        logger.debug({ skill: skill.name, trigger: skill.trigger.source }, '技能触发器匹配');
        return { skill, score: 1.0 };
      }
    }

    // 2. 关键词匹配（委托基类）
    const best = this.findBestKeywordMatch(userInput, SKILL_MATCH_MIN_SCORE);
    if (!best) return null;
    logger.debug({ matched: best.item.name, score: best.score }, '技能关键词匹配');
    return { skill: best.item, score: best.score };
  }

  // ── 公共方法 ──────────────────────────────────────

  /**
   * 根据技能名获取技能
   */
  get(name: string): SkillEntry | null {
    return this.items.find((s) => s.name === name) ?? null;
  }

  /**
   * 删除技能（向后兼容别名，委托基类 deleteItem）
   */
  deleteSkill(name: string): boolean {
    return this.deleteItem(name);
  }

  /**
   * 注册运行时注入的技能
   *
   * 供 SkillManager 运行态注册技能（如 confirmConfigSuggestion 持久化技能、
   * 或宿主直接注入）。重复注册同名技能会被拒绝。
   *
   * SSOT-R3-T8（2026-08-10）：改走基类 registerRuntimeItem 登记。
   * 此前直接 push 进 items，reload() 用磁盘扫描结果整体覆盖时会把注入技能抹除，
   * 而 SQLite 的 `skill:<name>` 索引行仍在 → 内存查不到、recall 仍能召回，两侧分叉。
   */
  register(skill: SkillEntry): void {
    if (this.items.some((s) => s.name === skill.name)) {
      throw configError(
        `技能 "${skill.name}" 已存在，不能重复注册`,
        undefined,
        ['请使用不同的技能名称'],
      );
    }
    this.registerRuntimeItem(skill);
    logger.info({ name: skill.name, keywords: skill.keywords.length }, '技能已注册（运行时注入）');
  }

  /**
   * 构建 system prompt 中的技能段
   */
  buildSystemPrompt(name?: string): string {
    if (!name) return '';
    const skill = this.get(name);
    if (!skill) return '';
    return `【当前技能】${skill.name}\n${skill.content}`;
  }

  /**
   * 构建全局技能清单块（渐进披露 L1，与角色包技能清单同格式，2026-08-18）
   *
   * 全局 skills 与角色包 skills 统一渐进披露逻辑：清单（name + description）常驻
   * system prompt，LLM 按需调用 read_skill 读取正文（L2）。两级技能同构——
   * 通用技能全局激活（清单常驻），角色包技能随角色激活（清单随 rolePackPrompt）。
   *
   * L3 提示：若技能含 resources/scripts，附加 "(含资源/脚本)" 标记。
   *
   * @returns 技能清单块（无技能时返回空串）
   */
  buildSkillList(): string {
    const listed = this.items.map((skill) => {
      const desc = skill.description ? `：${skill.description}` : '';
      const l3Tag = skill.layer3 && (skill.layer3.resources.length > 0 || skill.layer3.scripts.length > 0)
        ? '（含资源/脚本）'
        : '';
      return `- ${skill.name}${desc}${l3Tag}`;
    });
    return listed.length > 0
      ? `【通用技能（渐进披露 L1，按需调用 read_skill 读取正文）】\n${listed.join('\n')}`
      : '';
  }

  // ── L3 资源/脚本访问 ──────────────────────────────────

  /**
   * 读取技能的 L3 资源文件（渐进披露 L3）
   *
   * @param skillName 技能名
   * @param resourcePath 相对 resources/ 的路径（如 "api-spec.md"）
   * @returns 资源文件内容，不存在返回 null
   */
  async readResource(skillName: string, resourcePath: string): Promise<string | null> {
    const skill = this.get(skillName);
    if (!skill) return null;

    // 确认资源在 layer3 中（安全检查，防止路径穿越）
    if (skill.layer3?.resources.some((r) => r.path === resourcePath)) {
      const skillDir = dirname(skill.filePath);
      const resourceFullPath = join(skillDir, 'resources', resourcePath);
      try {
        return await readFile(resourceFullPath, 'utf-8');
      } catch (err) {
        logger.warn({ skill: skillName, resourcePath, err }, '读取 L3 资源失败');
        return null;
      }
    }
    return null;
  }

  /**
   * 列出技能的 L3 脚本
   *
   * @param skillName 技能名
   * @returns 脚本列表，无脚本返回空数组
   */
  listScripts(skillName: string): SkillLayer3['scripts'] {
    const skill = this.get(skillName);
    return skill?.layer3?.scripts ?? [];
  }

  /**
   * 获取脚本的完整路径
   *
   * @param skillName 技能名
   * @param scriptPath 相对 scripts/ 的路径
   * @returns 脚本完整路径，不存在返回 null
   */
  getScriptPath(skillName: string, scriptPath: string): string | null {
    const skill = this.get(skillName);
    if (!skill?.layer3?.scripts.some((s) => s.path === scriptPath)) return null;
    const skillDir = dirname(skill.filePath);
    return join(skillDir, 'scripts', scriptPath);
  }

  // ── 基类抽象方法实现 ──────────────────────────────

  protected async createEntry(entry: ScannedMarkdownEntry): Promise<SkillEntry> {
    // 发现 L3 资源和脚本（仅对文件夹形式的技能有效）
    let layer3: SkillLayer3 | undefined;
    const skillDir = dirname(entry.filePath);
    // 如果 filePath 指向 SKILL.md，skillDir 就是技能目录；如果是单文件 .md，也尝试扫描同级目录
    const discovered = await discoverLayer3(skillDir);
    if (discovered.resources.length > 0 || discovered.scripts.length > 0) {
      layer3 = {
        resources: discovered.resources.map((r) => ({
          path: r.path,
          size: r.size,
        })),
        scripts: discovered.scripts.map((s) => ({
          path: s.path,
          runtime: s.runtime,
          size: s.size,
        })),
      };
    }

    return {
      name: entry.name,
      keywords: parseKeywords(entry.frontmatter),
      trigger: parseTrigger(entry.frontmatter),
      description: entry.frontmatter['description'],
      content: entry.body.trim(),
      filePath: entry.filePath,
      layer: 'project',
      layer3,
    };
  }
}
