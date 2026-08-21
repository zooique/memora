/**
 * 技能管理器 — 继承 ConfigResourceManager，扩展 trigger 正则匹配 + 运行时注册。
 * 单层目录 <configDir>/skills/（宿主负责汇总全局+项目级技能到 configDir）。
 * 三级渐进披露：L1 元数据常驻 / L2 read_skill 按需 / L3 resources+scripts。
 * 触发：skill 文件 frontmatter 声明 keywords（逗号分隔）和 trigger（触发正则，可选）。
 */
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import type { SkillEntry, SkillMatch, SkillLayer3 } from '@/skill/types.js';
import { parseTrigger, parseKeywords, discoverLayer3, resolveSafePath } from '@/utils/scanner.js';
import type { ScannedMarkdownEntry } from '@/utils/scanner.js';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/**
 * 技能匹配最低激活阈值：score 低于此不激活，避免低匹配度噪音
 * （与角色包管理器 KEYWORD_HIGH_CONFIDENCE_THRESHOLD 0.3 一致）
 */
const SKILL_MATCH_MIN_SCORE = 0.3;

/**
 * 解析来源层（agent / project）：SSOT 收口——仅接受合法枚举值，
 * 非法/缺失回退 'project'（与历史默认一致，防御 frontmatter 手误导致契约外值透传宿主）。
 */
function resolveLayer(raw: unknown): 'agent' | 'project' {
  return raw === 'agent' ? 'agent' : 'project';
}

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
   * 根据用户输入匹配技能：先 trigger 正则（命中即 score=1.0），
   * 再关键词匹配（复用基类），得分低于 SKILL_MATCH_MIN_SCORE 不激活
   */
  match(userInput: string): SkillMatch | null {
    if (this.items.length === 0) return null;

    // 1. trigger 正则（最高优先级）
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
   * 注册运行时注入的技能（如 confirmConfigSuggestion 持久化技能）；同名重复注册被拒绝。
   *
   * 必须走基类 registerRuntimeItem 登记——直接 push 进 items 会被 reload() 的磁盘扫描结果覆盖，
   * 而 SQLite `skill:<name>` 索引行仍在 → 内存查不到、recall 仍能召回，两侧分叉。
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
   * 格式化单个技能为 Prompt 字符串
   *
   * SSOT：所有技能展示（System Prompt、Tool 回调）必须走此方法保证格式统一。
   * compress=true 时描述截断至 20 字（技能较多时的 token 节约）。
   */
  static formatSkillForPrompt(
    skill: { name?: string; description?: string; layer3?: { readonly resources: readonly unknown[]; readonly scripts: readonly unknown[] } } | undefined | null,
    fallbackName?: string,
    compress = false,
  ): string {
    const label = skill?.name || fallbackName || '';
    if (!label) return '';
    let desc = '';
    if (skill?.description) {
      const descText = compress && skill.description.length > 20
        ? skill.description.slice(0, 20) + '…'
        : skill.description;
      desc = `：${descText}`;
    }
    const hasL3 = skill?.layer3 && (skill.layer3.resources.length > 0 || skill.layer3.scripts.length > 0);
    const l3Tag = hasL3 ? '（含资源/脚本）' : '';
    return `- ${label}${desc}${l3Tag}`;
  }

  /**
   * 构建全局技能清单块（渐进披露 L1），与角色包技能清单同格式。
   * 两级技能同构：通用技能全局激活，角色包技能随角色激活；LLM 按需调 read_skill 读正文（L2）。
   * 含 resources/scripts 的技能附加 "(含资源/脚本)" 标记。
   */
  buildSkillList(): string {
    const listed = this.items.map((skill) => SkillManager.formatSkillForPrompt(skill));
    return listed.filter(Boolean).length > 0
      ? `【通用技能（渐进披露 L1，按需调用 read_skill 读取正文）】\n${listed.join('\n')}`
      : '';
  }

  // ── L3 资源/脚本访问 ──────────────────────────────────

  /**
   * 读取技能的 L3 资源文件（渐进披露 L3）；资源须在 layer3 中且路径不逃逸 resources/ 目录
   */
  async readResource(skillName: string, resourcePath: string): Promise<string | null> {
    const skill = this.get(skillName);
    if (!skill) return null;

    // 确认资源在 layer3 中 + 路径穿越防护
    if (skill.layer3?.resources.some((r) => r.path === resourcePath)) {
      const skillDir = dirname(skill.filePath);
      const resourceFullPath = resolveSafePath(join(skillDir, 'resources'), resourcePath);
      if (!resourceFullPath) {
        logger.warn({ skill: skillName, resourcePath }, 'read_resource 路径穿越被阻止');
        return null;
      }
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
   * 列出技能的 L3 资源
   */
  listResources(skillName: string): SkillLayer3['resources'] {
    const skill = this.get(skillName);
    return skill?.layer3?.resources ?? [];
  }

  /**
   * 列出技能的 L3 脚本
   */
  listScripts(skillName: string): SkillLayer3['scripts'] {
    const skill = this.get(skillName);
    return skill?.layer3?.scripts ?? [];
  }

  /**
   * 获取脚本的完整路径（须在 layer3 中且路径不逃逸 scripts/ 目录）
   */
  getScriptPath(skillName: string, scriptPath: string): string | null {
    const skill = this.get(skillName);
    if (!skill?.layer3?.scripts.some((s) => s.path === scriptPath)) return null;
    const skillDir = dirname(skill.filePath);
    return resolveSafePath(join(skillDir, 'scripts'), scriptPath);
  }

  // ── 基类抽象方法实现 ──────────────────────────────

  protected async createEntry(entry: ScannedMarkdownEntry): Promise<SkillEntry> {
    // 发现 L3 资源和脚本（folder 形式技能目录或单文件 skill 同级目录都会扫描）
    let layer3: SkillLayer3 | undefined;
    const skillDir = dirname(entry.filePath);
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
      // 来源层（agent / project）：解析 frontmatter.layer，非法/缺失回退 project（与现状默认一致）。
      // 宿主按此渲染「全局/项目」分层标签（host-alignment 约定 layer: agent 声明）。
      layer: resolveLayer(entry.frontmatter['layer']),
      layer3,
    };
  }
}
