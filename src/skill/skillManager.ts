/**
 * 技能管理器 — 单层目录扫描 + 关键词匹配
 *
 * 职责：
 *   - 启动时扫描 configDir/skills/ 目录
 *   - 通过关键词匹配选择技能（初期阶段一/二）
 *   - 技能文件不进入 SQLite 记忆索引——它是"配置"，不是"记忆"
 *   - 后期触发条件（≥15个技能 / 关键词命中率 <80%）→ 切换为 LLM 自主选择
 *
 * 设计原则（01-主架构-v4.0.md §5.2.1）：
 *   - 技能是"怎么做事"的配置，不是"记住了什么"的记忆
 *   - 单层目录：<configDir>/skills/（宿主负责汇总全局+项目级技能到 configDir）
 *   - 管理组件独立于 SQLite 记忆索引
 *
 * 触发词说明：
 *   每个 skill 文件的 frontmatter 声明 keywords（逗号分隔）和 trigger（触发正则，可选）。
 *   skill 文件命名规范：`<技能名>.md`（如"去AI味.md""审视角.md""写代码.md"）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { parseFrontmatter } from '@/memory/frontmatter.js';
import { logger } from '@/logging/logger.js';

/**
 * 技能条目（从 skills/*.md 解析）
 */
export interface SkillEntry {
  /** 技能名（文件名去 .md） */
  name: string;
  /** 触发关键词列表 */
  keywords: string[];
  /** 触发正则（可选，优先级高于 keywords） */
  trigger?: RegExp;
  /** 技能描述（可选） */
  description?: string;
  /** 技能 prompt 正文 */
  content: string;
  /** 来源路径 */
  filePath: string;
  /** 来源层（agent / project） */
  layer: 'agent' | 'project';
}

/**
 * 技能匹配结果
 */
export interface SkillMatch {
  /** 匹配的技能 */
  skill: SkillEntry;
  /** 匹配得分（0-1，用于排序） */
  score: number;
}

/**
 * 技能管理器
 */
export class SkillManager {
  /** 技能列表缓存（启动时扫描一次） */
  private skills: SkillEntry[] = [];

  /** 关键词索引（keyword → 技能名列表） */
  private keywordIndex: Map<string, string[]> = new Map();

  /**
   * @param configDir 配置目录（技能文件在 <configDir>/skills/ 下）
   */
  constructor(
    private readonly configDir?: string,
  ) {}

  /**
   * 启动时加载：扫描两层目录 + 构建关键词索引
   *
   * @returns 加载的技能数量
   */
  load(): number {
    this.skills = this.scanSkills();
    this.buildKeywordIndex();
    logger.info(
      { count: this.skills.length, names: this.skills.map((s) => s.name) },
      '技能加载完成',
    );
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

    // 2. 关键词匹配（TF 计分）
    const matches: SkillMatch[] = [];
    // 分词：中英文分别提取
    const tokens = this.tokenize(userInput);

    for (const skill of this.skills) {
      if (skill.keywords.length === 0) continue;

      let hitCount = 0;
      for (const kw of skill.keywords) {
        // 支持部分匹配（子串搜索）
        if (tokens.some((t) => t.includes(kw)) || userInput.includes(kw)) {
          hitCount++;
        }
      }

      if (hitCount > 0) {
        // 得分 = 命中关键词数 / 技能关键词总数（归一化）
        const score = hitCount / Math.max(skill.keywords.length, 1);
        matches.push({ skill, score });
      }
    }

    if (matches.length === 0) return null;

    // 得分从高到低排序，取第一个
    matches.sort((a, b) => b.score - a.score);
    logger.debug({ matched: matches[0]!.skill.name, score: matches[0]!.score }, '技能关键词匹配');
    return matches[0]!;
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
   * 注册运行时注入的技能（C1 修复）
   *
   * 供 Agent.addSkill() 调用：宿主程序可在 init() 之后动态注入技能。
   * 重复注册同名技能会被拒绝（与文件加载的技能冲突时也按"先到先得"判断）。
   *
   * @param skill 技能条目
   * @throws 技能名已存在时抛错
   */
  register(skill: SkillEntry): void {
    if (this.skills.some((s) => s.name === skill.name)) {
      throw new Error(`技能 "${skill.name}" 已存在，不能重复注册`);
    }
    this.skills.push(skill);
    // 重建关键词索引（增量构建较复杂，全量重建简单可靠）
    this.buildKeywordIndex();
    logger.info({ name: skill.name, keywords: skill.keywords.length }, '技能已注册（运行时注入）');
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
   * 扫描 configDir/skills/ 目录
   *
   * 宿主负责将全局+项目级技能汇总到 configDir，
   * 内核只扫描一个目录，不做路径假设。
   */
  private scanSkills(): SkillEntry[] {
    const map = new Map<string, SkillEntry>();

    if (this.configDir) {
      const skillsDir = resolve(this.configDir, 'skills');
      this.scanDir(skillsDir, 'project', map);
    }

    return Array.from(map.values());
  }

  /**
   * 扫描单个目录下的 *.md 文件，解析技能
   *
   * 排除规则（与 agent设计.md §10.6.1 一致）：
   *   - 文件名以 `.` 开头的隐藏文件
   *   - 文件名以 `_` 前缀的私有文件
   *   - README.md / CHANGELOG.md / LICENSE
   *
   * @param dir 目录路径
   * @param layer 来源层
   * @param map 技能 Map（同名覆盖）
   */
  private scanDir(dir: string, layer: 'agent' | 'project', map: Map<string, SkillEntry>): void {
    if (!existsSync(dir)) {
      logger.debug({ dir }, '技能目录不存在，跳过');
      return;
    }

    // 排除列表
    const EXCLUDED = new Set(['README.md', 'CHANGELOG.md', 'LICENSE']);

    let files: string[];
    try {
      files = readdirSync(dir).filter(
        (f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_') && !EXCLUDED.has(f),
      );
    } catch {
      logger.warn({ dir }, '扫描技能目录失败');
      return;
    }

    for (const file of files) {
      try {
        const filePath = join(dir, file);
        const raw = readFileSync(filePath, 'utf-8');
        const { frontmatter: fm, body } = parseFrontmatter(raw);

        const name = fm['name'] ?? basename(file, '.md');

        // 解析 keywords（逗号分隔）
        const keywords: string[] = fm['keywords']
          ? String(fm['keywords'])
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [];

        // 解析 trigger（正则字符串，格式：/pattern/flags）
        let trigger: RegExp | undefined;
        if (fm['trigger']) {
          try {
            const pattern = String(fm['trigger']).trim();
            // 安全解析：先检测是否以 / 开头，再找末尾 /flags
            const match = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
            const clean = match ? match[1]! : pattern;
            trigger = new RegExp(clean, 'i');
          } catch {
            logger.warn({ file, trigger: fm['trigger'] }, '技能触发正则无效，已忽略');
          }
        }

        const skill: SkillEntry = {
          name,
          keywords,
          trigger,
          description: fm['description'],
          content: body.trim(),
          filePath,
          layer,
        };

        map.set(name, skill); // 同名覆盖（项目级覆盖全局级）
      } catch (err) {
        logger.warn({ file, err }, '解析技能文件失败');
      }
    }
  }

  /**
   * 构建关键词 → 技能名的反向索引
   *
   * 每个关键词可能对应多个技能，匹配时按 TF 计分。
   */
  private buildKeywordIndex(): void {
    this.keywordIndex.clear();
    for (const skill of this.skills) {
      for (const kw of skill.keywords) {
        const list = this.keywordIndex.get(kw) ?? [];
        list.push(skill.name);
        this.keywordIndex.set(kw, list);
      }
    }
  }

  /**
   * 简单分词（中英文混合）
   *
   * 中文不做分词（基于子串匹配），英文和标点按空格/标点分割。
   * @returns 分词后的 token 列表
   */
  private tokenize(input: string): string[] {
    // 英文/数字/标点按非中文字符分割；中文保留为整体 tokens
    const tokens: string[] = [];

    // 提取中文连续段（2 字以上的中文 token）
    const chineseSegments = input.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    tokens.push(...chineseSegments);

    // 提取英文词
    const englishSegments = input.match(/[a-zA-Z0-9]+/g) ?? [];
    tokens.push(...englishSegments);

    return tokens;
  }
}
