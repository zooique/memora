/**
 * 技能管理器 — 继承 ConfigResourceManager。
 * 单层目录 <configDir>/skills/（宿主负责汇总全局+项目级技能到 configDir）。
 * 三级渐进披露：L1 元数据常驻 / L2 read_skill 按需 / L3 resources+scripts。
 */
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import type { SkillEntry, SkillLayer3, SkillIssue, SkillValidation } from '@/skill/types.js';
import { scanMarkdownDir } from '@/utils/scanner.js';
import { parseFrontmatter } from '@/utils/frontmatter.js';
import type { ScannedMarkdownEntry } from '@/utils/scanner.js';
import {
  discoverSkillLayer3,
  projectDiscoveredLayer3,
  resolveSkillDir,
  findLayer3Resource,
  resolveLayer3ResourcePath,
  resolveLayer3ScriptPath,
} from '@/skill/skillLayer3.js';
import { readFileCapped, existsSyncSafe } from '@/utils/fileSafe.js';

/**
 * L1 阈值保护：技能数超过此值时压缩 L1 描述为 20 字摘要。
 * SSOT：全局技能（SkillManager）与角色包内嵌技能（RolePackManager）共用同一渐进披露阈值。
 */
export const L1_COMPRESSED_THRESHOLD = 30;
/** L1 阈值保护：技能数超过此值时切换为 list_skills 工具动态查询（SSOT 同一来源） */
export const L1_LIST_TOOL_THRESHOLD = 50;

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
   * 必须走基类 registerRuntimeItem 登记——直接 push 进 items 会被 reload() 的磁盘扫描结果覆盖
   * （运行时注入项无磁盘真理源，reload 保留依赖 runtimeNames 记账；设定记忆不写记忆库/SQLite 索引）。
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
    logger.info({ name: skill.name }, '技能已注册（运行时注入）');
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
   *
   * L1 阈值保护（与角色包 buildSystemPrompt 同构）：
   *   ≤ 30 技能：完整 L1（name + full description）
   *   31-50 技能：压缩 L1（name + 20 字摘要）
   *   > 50 技能：切换 list_skills 工具动态查询，不在 system prompt 枚举
   */
  buildSkillList(): string {
    // 可用性过滤（G22）：缺 description 的技能在后手来源与渐进披露层面不可用（模型不知何时激活），
    // 不进入 LLM 可用清单（「未生效」由宿主 UI 以健康徽章显式标注，而非静默隐藏）。
    const candidates = this.items.filter((s) => s.description?.trim());
    if (candidates.length === 0) return '';
    const skillCount = candidates.length;

    // L1 阈值保护：超上限不枚举，提示用 list_skills 工具动态查询
    if (skillCount > L1_LIST_TOOL_THRESHOLD) {
      return `【通用技能（${skillCount} 个，数量较多，使用 list_skills 工具查询具体清单）】`;
    }

    const compressed = skillCount > L1_COMPRESSED_THRESHOLD;
    const listed = candidates
      .map((skill) => SkillManager.formatSkillForPrompt(skill, undefined, compressed))
      .filter(Boolean);
    if (listed.length === 0) return '';
    const modeNote = compressed
      ? '（技能较多，描述已压缩至 20 字，可用 read_skill 读取完整正文）'
      : '（渐进披露 L1，按需调用 read_skill 读取正文）';
    return `【通用技能${modeNote}】\n${listed.join('\n')}`;
  }

  /**
   * 校验单技能文件（G22 写→验→用闭环，宿主 UI 校验入口）。
   * 复用 parser frontmatter 解析做单一真理源，不重写解析；只做确定性结构检查，不做语义 schema。
   * 判级（三点强化，2026-08-25 吸收社区养分）：
   *   - error：无 frontmatter / description 缺失/空（渐进披露唯一依据，缺则技能不可用）/ 正文空
   *   - warning：layer 非法（回退 project）
   */
  async validateFile(filePath: string): Promise<SkillValidation> {
    const issues: SkillIssue[] = [];
    // 读取收口于 fileSafe.readFileCapped（统一长度上限保护，与角色包内容读取同级）
    const raw = await readFileCapped(filePath);
    if (raw === null) {
      return { ok: false, issues: [{ level: 'error', field: 'file', message: '无法读取技能文件' }] };
    }
    const { frontmatter, body } = parseFrontmatter(raw);

    // 无 frontmatter 结构（fallback：整体落入 body 且无任何键值）→ 不被识别
    if (Object.keys(frontmatter).length === 0 && body === raw) {
      issues.push({ level: 'error', field: 'frontmatter', message: '缺少 frontmatter（文件需以 --- 开头声明 name/description）' });
    }
    const desc = frontmatter['description'];
    if (!desc || !desc.trim()) {
      issues.push({ level: 'error', field: 'description', message: '缺少 description：渐进披露不暴露，模型不知何时激活此技能' });
    }
    if (!body.trim()) {
      issues.push({ level: 'error', field: 'body', message: '技能正文为空，无可执行指令' });
    }
    const layer = frontmatter['layer'];
    if (layer && layer !== 'agent' && layer !== 'project') {
      issues.push({ level: 'warning', field: 'layer', message: `layer 值「${layer}」非法，将回退为 project` });
    }
    return { ok: issues.every((i) => i.level !== 'error'), issues };
  }

  // ── L3 资源/脚本访问 ──────────────────────────────────

  /**
   * 读取技能的 L3 资源文件（渐进披露 L3）；资源须在 layer3 中且路径不逃逸其来源子目录
   * （resources/ 或 references/，B1 兼容主流 references/ 辅助文档目录）
   */
  async readResource(skillName: string, resourcePath: string): Promise<string | null> {
    const skill = this.get(skillName);
    if (!skill) return null;

    // 白名单前置：资源须已由扫描登记在 layer3 中（未登记 → 静默 null，与历史行为一致）
    if (!findLayer3Resource(skill.layer3, resourcePath)) return null;
    // 路径解析（按条目来源子目录选基目录 + 路径穿越防护）收口于 skillLayer3（SSOT）
    const skillDir = resolveSkillDir(skill.filePath);
    const resourceFullPath = resolveLayer3ResourcePath(skillDir, skill.layer3, resourcePath);
    if (!resourceFullPath) {
      logger.warn({ skill: skillName, resourcePath }, 'read_resource 路径穿越被阻止');
      return null;
    }
    // 读取收口于 fileSafe.readFileCapped：长度上限保护与角色包内嵌技能同级（差异点取更全面形态）
    const content = await readFileCapped(resourceFullPath);
    if (content === null) {
      logger.warn({ skill: skillName, resourcePath }, '读取 L3 资源失败');
      return null;
    }
    return content;
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
    if (!skill) return null;
    const skillDir = resolveSkillDir(skill.filePath);
    const fullPath = resolveLayer3ScriptPath(skillDir, skill.layer3, scriptPath);
    if (!fullPath) return null;
    // 存在性校验与角色包内嵌技能对齐（差异点取更全面形态）：防止交出指向缺失脚本的路径
    return existsSyncSafe(fullPath) ? fullPath : null;
  }

  // ── 基类抽象方法实现 ──────────────────────────────

  /**
   * 加载用户目录的技能（宿主调用，用于扩展内置技能池）
   *
   * 与 load() 的区别：
   * - load() 从 configDir/skills/ 扫描内置技能（有磁盘真理源）
   * - loadExtraDir() 从额外目录扫描用户技能（运行时注入，reload 时保留）
   *
   * 设计哲学：内核保持单一真理源（configDir/skills/），宿主负责扩展用户目录。
   * 用户技能通过 registerRuntimeItem 注入，reload() 时会保留（同名冲突以磁盘为准）。
   *
   * @param dir 用户技能目录（如 ~/.memora/skills/）
   * @returns 加载的技能数量
   */
  async loadExtraDir(dir: string): Promise<number> {
    const entries = await scanMarkdownDir(dir);
    let count = 0;
    for (const entry of entries) {
      // 跳过已存在的技能（内置技能优先）
      if (this.items.some((s) => s.name === entry.name)) {
        logger.info({ name: entry.name }, '用户技能与内置重名，跳过');
        continue;
      }
      const skill = await this.createEntry(entry);
      if (skill) {
        this.registerRuntimeItem(skill);
        count++;
      }
    }
    logger.info({ count, dir }, '用户技能加载完成');
    return count;
  }

  protected async createEntry(entry: ScannedMarkdownEntry): Promise<SkillEntry> {
    // L3 隔离纪律（2026-08-30 对齐 Claude Code 主流）：仅「文件夹形态」（入口为 SKILL.md）才发现
    // resources/ scripts/。顶层裸 .md 单文件技能目录 = 技能池共享根，同级扫描会把别的技能的
    // resources/scripts 误归给自己 → 污染。故裸 .md 为纯 L1/L2，需要 L3 资源/脚本必须用文件夹+SKILL.md。
    //
    // 该规则与角色包内嵌技能**逐字同构**；发现与投影均已收口于 skillLayer3
    // （discoverSkillLayer3 + projectDiscoveredLayer3，SSOT）——此前两侧各写一遍投影，
    // 改一处即静默漂移。
    const discovered = await discoverSkillLayer3(entry.filePath);
    const layer3 = projectDiscoveredLayer3(discovered);

    return {
      name: entry.name,
      description: entry.frontmatter['description'],
      content: entry.body.trim(),
      filePath: entry.filePath,
      // 来源层（agent / project）：解析 frontmatter.layer，非法/缺失回退 project（与现状默认一致）。
      // ⚠️ 展示语义不由本字段单独决定：宿主以 filePath 前缀为主判据，
      // 本字段仅在无路径/未命中时兜底（project → 用户源，agent → 内置源）。
      layer: resolveLayer(entry.frontmatter['layer']),
      layer3,
    };
  }
}
