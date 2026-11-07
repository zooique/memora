/**
 * 技能管理器 — 继承 ConfigResourceManager。
 * 三层来源：内置 <configDir>/skills/（磁盘真理源）+ 额外目录（loadExtraDir 运行时注入）：
 * 用户级（globalStorage/skills）与项目级（<workspace>/.memora/skills）。
 * 覆盖优先级 = **加载顺序**（内置 → 用户 → 项目，后加载者胜），与列表展示排序无关。
 * 三级渐进披露：L1 元数据常驻 / L2 read_skill 按需 / L3 resources+scripts。
 */
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { basename, dirname, join } from 'node:path';
import {
  ConfigResourceManager,
  isOutOfOrderExtraTier,
  type AssetExtraTier,
} from '@/utils/configResourceManager.js';
import type { SkillEntry, SkillLayer3, SkillIssue, SkillValidation } from '@/skill/types.js';
import { extractDisplayName, isFolderFormSkill, scanMarkdownDir } from '@/utils/scanner.js';
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
 * 正文引用的 L3 目录路径（`references/` `resources/` `scripts/` 后紧跟文件名）。
 * 目录名真源 = `utils/scanner` 的三个子目录常量；负向环视排除 URL 与相对路径
 * （`https://x/scripts/y`、`../scripts/y` 不算正文引用）。
 * 镜像点（刻意为之）：内核 `validateFile` 是**运行时**真源；生成期闸门
 * `hosts/.../_lib/verify-core.mjs` 是**预检镜像**（脚本无法 import 内核包，
 * 内核也不能反向依赖宿主资源，故同一判据存在两份实现，改动须同步）。
 */
const L3_REF_RE = /(?<![\w./-])(references|resources|scripts)\/([^\s`'"()<>]+)/g;

/** 引用末尾的标点（中文句读 / 英文标点 / 右括号）不属于路径本身 */
const REF_TRAILING_PUNCT_RE = /[.,;:!?，。、；：！？)】」』]+$/;

/**
 * 解析来源层（agent / project）：SSOT 收口——仅接受合法枚举值，
 * 非法/缺失回退 'project'（与历史默认一致，防御 frontmatter 手误导致契约外值透传宿主）。
 */
function resolveLayer(raw: unknown): 'agent' | 'project' {
  return raw === 'agent' ? 'agent' : 'project';
}

/**
 * 额外技能目录的档位（决定同名覆盖优先级：project > user > builtin）
 *
 * 档位只影响**记账口径**与**非法顺序的守卫**，真正生效的覆盖由**加载顺序**决定
 * （宿主必须先 user、后 project；先加载者被后加载者覆盖）。
 * 类型本体 = `AssetExtraTier`（唯一判据，见 utils/configResourceManager），本名只是就地别名。
 */
export type SkillExtraTier = AssetExtraTier;

/**
 * 技能管理器
 */
export class SkillManager extends ConfigResourceManager<SkillEntry> {
  /**
   * 已被**用户级**技能覆盖的内置技能名。
   *
   * 与基类 runtimeNames 记账互补：runtimeNames 说明「该项无内核扫描真理源」，
   * 本集合说明「同名内置项被用户版覆盖」——reload 扫描回同名内置时
   * 以用户版为准（基类 isUserOverride 钩子）。load()（纯内置重载）时一并清空。
   */
  private readonly userOverrides = new Set<string>();

  /**
   * 已被**项目级**技能覆盖的技能名（覆盖对象可能是内置、也可能是先加载的用户版）。
   *
   * 与 `userOverrides` 严格分账：项目覆盖**不计入用户覆盖**（否则「用户覆盖了内置」
   * 这类报表会被项目级来源污染）。`isUserOverride` 取两者并集，只因基类只有一个
   * 「运行时项胜过磁盘同名」的布尔位——并集不影响分账可观测性。
   */
  private readonly projectOverrides = new Set<string>();

  /**
   * 额外技能目录清单（loadExtraDir 注入时登记，值 = 档位）。
   *
   * 记账目的：`reload()` 必须能**统一重扫** configDir + 这些目录——若只靠宿主在刷新时
   * 再传一次路径，就会出现「装配期一条路径、刷新时另一条路径」的两份来源（同一目录
   * 两个真源，漏传即静默失效）。登记在此后，宿主只需调窄口 `resyncUserSkills()`。
   * **Map 的插入序 = 加载顺序 = 覆盖顺序**（宿主按 user → project 登记）。
   */
  private readonly extraDirs = new Map<string, SkillExtraTier>();

  /**
   * 来自额外目录的技能名集合（loadExtraDir 注入成功者，用户 + 项目合计）。
   *
   * 与 runtimeNames 的区别：runtimeNames 还包含 `register()` 注入的运行时技能，reload
   * 必须保留它们；只有本集合里的名字才该在重扫时先摘除再按磁盘重建。
   */
  private readonly extraSkillNames = new Set<string>();

  /**
   * 每个额外目录注入技能名 → 来源目录。
   *
   * 幂等判据的真源：**同一目录**重复扫描才跳过；同名但来自**不同目录**时，
   * 后加载者胜（覆盖语义，不再误拦）。旧实现按名字全局幂等，导致项目级同名项
   * 被用户级先注入的同名项挡掉。
   */
  private readonly injectedFrom = new Map<string, string>();

  /**
   * 禁用的技能名集合：宿主配置形态启停。命中者
   * get() 返回 null（read_skill/L3 全链路经 get 短路）+ buildSkillList 不枚举。
   * list 快照保持完整——宿主 UI 依据同名设置标注「已禁用」徽章（对 LLM 静默）。
   *
   * **作用域 = 全局技能池（内置/用户）**：角色包内嵌技能由 RolePackManager 持有、
   * 不经本管理器（其启用判据 = 角色是否激活），对本集**免疫**——角色包技能
   * 「随角色启停、不可按名禁用」（见宿主 skillAggregation 定案声明）。
   */
  private readonly disabledNames = new Set<string>();

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
   * 重载：configDir 与全部已登记的额外技能目录**统一重扫**（重扫真理源单点）。
   *
   * 与基类 reload 的差异只在一处：基类只扫 configDir 并保留运行时注入项，本类还需把
   * 额外目录（用户级 + 项目级）的磁盘变化重新读进来（新增 / 改名 / 删除 / 内容修改）。执行序：
   *   1. 摘除全部额外目录注入项（`extraSkillNames`；register() 注入项不动，仍由基类保留）；
   *   2. 清空覆盖记账与来源映射（否则旧账会让重扫后的同名项被误拦，且新目录内容无法重建）；
   *   3. `super.reload()` 重扫 configDir（内置）；
   *   4. 按 `extraDirs` 的**登记顺序**逐目录 `loadExtraDir()` 重扫——用户级先、项目级后，
   *      后加载者胜（覆盖语义由该方法自身处理）。
   *
   * @returns 重载后的技能总数
   */
  override async reload(): Promise<number> {
    this.removeExtraItems();
    await this.rescanAllSources();
    return this.items.length;
  }

  /**
   * 重扫额外技能目录并与内存池对账（设置页「刷新技能」的唯一内核落点）。
   *
   * 形态对齐 `RolePackManager.resyncUserPacks`：先摘除本管理器持有的额外目录注入项，
   * 再统一重扫（configDir + extraDirs），最后回报对账结果。
   * 与角色包版本的差异：技能没有「激活态」，故无 activeFallback。
   *
   * @returns added 净新增数；removed 真消失的技能名；updated **重扫后仍存在的同名项**
   *   （字段保留以维持公开窄口形状；它**不代表内容变化**——不比对内容，避免引入
   *   「什么算变化」的第二套定义与一次全量读取）
   */
  async resyncUserSkills(): Promise<{ added: number; removed: string[]; updated: string[] }> {
    // 摘除前名单 = 对账基线之一（deleteItem 同时注销运行时记账）
    const beforeNames = this.removeExtraItems();
    // 摘除后的池 = 净差基线（register() 注入项仍在，重扫不触碰它们）
    const baseline = new Set(this.items.map((s) => s.name));
    await this.rescanAllSources();
    const finalNames = new Set(this.items.map((s) => s.name));
    const removed = beforeNames.filter((name) => !finalNames.has(name));
    // updated = 同名留存（非内容变更）；宿主文案不得把它渲染成「更新 N 个」
    const updated = beforeNames.filter((name) => finalNames.has(name));
    const added = [...finalNames].filter(
      (name) => !baseline.has(name) && !beforeNames.includes(name),
    ).length;
    logger.info({ added, removed, updated }, '额外技能目录已重扫对账');
    return { added, removed, updated };
  }

  /**
   * 摘除全部额外目录注入项并清账（reload / resync 的共同前置步骤）。
   *
   * `register()` 注入项不在 `extraSkillNames` 内，故不受影响（仍由基类记账保留）。
   *
   * @returns 摘除前的额外目录技能名快照（resync 对账用）
   */
  private removeExtraItems(): string[] {
    const names = [...this.extraSkillNames];
    for (const name of names) this.deleteItem(name);
    this.clearExtraBookkeeping();
    return names;
  }

  /**
   * 统一重扫全部来源（重扫逻辑单点）：先基类扫 configDir（内置），再按登记序扫额外目录。
   *
   * reload 与 resyncUserSkills 共用本方法——两处各写一遍重扫序会产生第二份「扫什么」清单，
   * 改一处即静默漂移（SSOT 纪律）。
   */
  private async rescanAllSources(): Promise<void> {
    await super.reload();
    for (const [dir, tier] of this.extraDirs) {
      await this.loadExtraDir(dir, tier);
    }
  }

  /** 清空额外目录的全部记账（覆盖分账 + 注入名单 + 来源映射；目录登记本身保留） */
  private clearExtraBookkeeping(): void {
    this.extraSkillNames.clear();
    this.injectedFrom.clear();
    this.userOverrides.clear();
    this.projectOverrides.clear();
  }

  /**
   * 用户级覆盖内置的技能名快照（只读，供宿主/测试核对分账口径）。
   * 项目级覆盖**不在**本集合内（见 `projectOverrideNames`）。
   */
  get userOverrideNames(): string[] {
    return [...this.userOverrides];
  }

  /**
   * 项目级覆盖（内置或用户级）的技能名快照（只读，供宿主/测试核对分账口径）。
   */
  get projectOverrideNames(): string[] {
    return [...this.projectOverrides];
  }

  // ── 公共方法 ──────────────────────────────────────

  /**
   * 根据技能名获取技能
   */
  get(name: string): SkillEntry | null {
    // 禁用技能对 LLM 不可见：get=null → read_skill 报未找到、L3 全链路短路
    if (this.disabledNames.has(name)) return null;
    return this.items.find((s) => s.name === name) ?? null;
  }

  /**
   * 设置禁用技能清单（配置形态启停；装配期一次性注入，可由 reloadConfig 重设）
   *
   * @param names 禁用的技能名（命中者 L1/L2/L3 全不可用；对 LLM 语义 = 不存在）
   */
  setDisabledSkills(names: Iterable<string>): void {
    this.disabledNames.clear();
    for (const name of names) this.disabledNames.add(name);
    logger.info({ count: this.disabledNames.size }, '技能禁用集已设置');
  }

  /**
   * 当前禁用技能名快照（只读）——宿主 UI 渲染「已禁用」徽章的真源。
   *
   * 为何由内核提供而非宿主自读一份配置：**实际生效的禁用集在内核**（`disabledNames` 是
   * `get()` / `buildSkillList()` 的判据）。宿主若另读 workspace 配置，会出现「UI 标注的」
   * 与「实际生效的」两源分叉（如 reloadConfig 重设后不同步）。
   *
   * ⚠️ 对 **LLM** 仍然静默：本 getter 仅供宿主 UI 对照显示，
   * **不得**出现在工具返回、L1 清单或任何进入上下文的文本里（语义 = 技能不存在）。
   */
  get disabledSkillNames(): string[] {
    return [...this.disabledNames];
  }

  /**
   * 注册运行时注入的技能（如 confirmConfigSuggestion 持久化技能）；同名重复注册被拒绝。
   *
   * 必须走基类 registerRuntimeItem 登记——直接 push 进 items 会被 reload() 的磁盘扫描结果覆盖
   * （运行时注入项无磁盘真理源，reload 保留依赖 runtimeNames 记账；设定记忆不写记忆库）。
   */
  register(skill: SkillEntry): void {
    if (this.items.some((s) => s.name === skill.name)) {
      throw configError(`技能 "${skill.name}" 已存在，不能重复注册`, undefined, [
        '请使用不同的技能名称',
      ]);
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
    skill:
      | {
          name?: string;
          description?: string;
          layer3?: { readonly resources: readonly unknown[]; readonly scripts: readonly unknown[] };
        }
      | undefined
      | null,
    fallbackName?: string,
    compress = false,
  ): string {
    const label = skill?.name || fallbackName || '';
    if (!label) return '';
    let desc = '';
    if (skill?.description) {
      const descText =
        compress && skill.description.length > 20
          ? skill.description.slice(0, 20) + '…'
          : skill.description;
      desc = `：${descText}`;
    }
    const hasL3 =
      skill?.layer3 && (skill.layer3.resources.length > 0 || skill.layer3.scripts.length > 0);
    const l3Tag = hasL3 ? '（含资源/脚本）' : '';
    return `- ${label}${desc}${l3Tag}`;
  }

  /**
   * 对 **LLM 可见**的技能条目——渐进披露可用性判据的**唯一真理源**。
   *
   * 判据两条（缺一不可）：
   *   ① 有 `description`（渐进披露的唯一依据：缺则模型不知何时激活）；
   *   ② 未命中 `disabledNames`（启停：对模型语义 = 不存在）。
   *
   * ⚠️ **L1 枚举**（`buildSkillList`）与 **`list_skills` 工具侧**（assembler 注入回调）
   * 必须共用本方法：两者同为 **LLM 消费**、是同一份清单的两个交付通道，
   * 判据一旦分叉即「双轨镜像」（同一模型在两条路径看到不同技能集）。
   * 教训：启停/可用性过滤须两侧同步——单侧漏改会让禁用技能在另一通道仍可见。
   *
   * 注：本方法**不**过滤 L3 归属，也不做排序——排序由调用方决定（两通道排序本就不同）。
   */
  listAvailable(): SkillEntry[] {
    return this.items.filter((s) => s.description?.trim() && !this.disabledNames.has(s.name));
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
    // 可用性 + 禁用过滤**收口于 listAvailable**（LLM 可见集唯一真理源，
    // 与 list_skills 工具侧共用；此处不再自写 filter，防两通道判据分叉）。
    // 不进清单者由宿主 UI 显式标注而非静默隐藏：「未生效」= 健康徽章 / 禁用 = 「已禁用」徽章。
    const candidates = this.listAvailable();
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
   * 校验单技能文件（写→验→用闭环，宿主 UI 校验入口）。
   * 复用 parser frontmatter 解析做单一真理源，不重写解析；只做确定性结构检查，不做语义 schema。
   * 判级（判据清单）：
   *   - error：无 frontmatter / description 缺失/空（渐进披露唯一依据，缺则技能不可用）/ 正文空
   *   - error：声明了 `name` 但与磁盘名（目录名 / 文件名）不一致（用户/项目级手写技能无生成器闸门，运行期兜底）
   *   - error：正文引用的 `references/` `resources/` `scripts/` 文件不存在（L3 读取必然失败）
   *   - warning：layer 非法（回退 project）
   */
  async validateFile(filePath: string): Promise<SkillValidation> {
    const issues: SkillIssue[] = [];
    // 读取收口于 fileSafe.readFileCapped（统一长度上限保护，与角色包内容读取同级）
    const raw = await readFileCapped(filePath);
    if (raw === null) {
      return {
        ok: false,
        issues: [{ level: 'error', field: 'file', message: '无法读取技能文件' }],
      };
    }
    const { frontmatter, body } = parseFrontmatter(raw);

    // 无 frontmatter 结构（fallback：整体落入 body 且无任何键值）→ 不被识别
    if (Object.keys(frontmatter).length === 0 && body === raw) {
      issues.push({
        level: 'error',
        field: 'frontmatter',
        message: '缺少 frontmatter（文件需以 --- 开头声明 name/description）',
      });
    }
    const desc = frontmatter['description'];
    if (!desc || !desc.trim()) {
      issues.push({
        level: 'error',
        field: 'description',
        message: '缺少 description：渐进披露不暴露，模型不知何时激活此技能',
      });
    }
    if (!body.trim()) {
      issues.push({ level: 'error', field: 'body', message: '技能正文为空，无可执行指令' });
    }
    const layer = frontmatter['layer'];
    if (layer && layer !== 'agent' && layer !== 'project') {
      issues.push({
        level: 'warning',
        field: 'layer',
        message: `layer 值「${layer}」非法，将回退为 project`,
      });
    }

    // 命名一致性：技能以磁盘名定位（scanner 回退口径），声明 name 时必须与之一致。
    // 生成器产出的技能已在交付前校验；用户/项目级手写技能无该闸门，运行期在此兜底。
    const folderForm = isFolderFormSkill(filePath);
    const diskName = folderForm ? basename(dirname(filePath)) : basename(filePath, '.md');
    const declaredName = frontmatter['name'];
    if (declaredName && declaredName !== diskName) {
      issues.push({
        level: 'error',
        field: 'name',
        message: `name「${declaredName}」与磁盘名「${diskName}」不一致（技能以磁盘名定位，声明须一致）`,
      });
    }

    // 正文 L3 引用存在性：声明了不存在的 references/resources/scripts 文件时，
    // read_resource 只能返回 null（不是「没写引用」，而是「写了但读不到」）。
    const refBaseDir = dirname(filePath);
    const missingRefs = new Set<string>();
    for (const match of body.matchAll(L3_REF_RE)) {
      const subdir = match[1];
      const filePart = (match[2] ?? '').replace(REF_TRAILING_PUNCT_RE, '');
      if (!subdir || !filePart) continue;
      const refPath = `${subdir}/${filePart}`;
      if (!existsSyncSafe(join(refBaseDir, refPath))) missingRefs.add(refPath);
    }
    for (const refPath of missingRefs) {
      issues.push({
        level: 'error',
        field: 'references',
        message: `正文引用的 ${refPath} 不存在（L3 读取会失败）`,
      });
    }
    return { ok: issues.every((i) => i.level !== 'error'), issues };
  }

  // ── L3 资源/脚本访问 ──────────────────────────────────

  /**
   * 读取技能的 L3 资源文件（渐进披露 L3）；资源须在 layer3 中且路径不逃逸其来源子目录
   * （resources/ 或 references/，兼容主流 references/ 辅助文档目录）
   */
  async readResource(skillName: string, resourcePath: string): Promise<string | null> {
    const skill = this.get(skillName);
    if (!skill) return null;

    // 白名单前置：资源须已由扫描登记在 layer3 中（未登记 → 静默 null）
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
   * 加载额外目录的技能（宿主调用，用于扩展内置技能池）
   *
   * 与 load() 的区别：
   * - load() 从 configDir/skills/ 扫描内置技能（有磁盘真理源）
   * - loadExtraDir() 从额外目录扫描（运行时注入，reload 时保留）
   *
   * 设计哲学：内核保持单一真理源（configDir/skills/），宿主负责扩展额外目录。
   * 覆盖优先级 = **加载顺序**（内置 → 用户 → 项目，后加载者胜）：
   *   - 同名内置项被覆盖 → 按 `tier` 分账（用户覆盖 / 项目覆盖，互不混账）；
   *   - 同名额外项被后加载目录覆盖 → 后加载者胜（项目覆盖用户时撤销用户覆盖账）；
   *   - **同一目录**重复扫描 → 幂等跳过（避免同名双存）。
   *
   * @param dir 额外技能目录（用户级如 globalStorage/skills；项目级如 <workspace>/.memora/skills）
   * @param tier 档位（决定覆盖记账；默认 'user'，宿主注入项目目录时显式传 'project'）
   * @returns 本次从该目录净注入的技能数量（含覆盖）
   */
  async loadExtraDir(dir: string, tier: SkillExtraTier = 'user'): Promise<number> {
    // 登记目录：reload/resync 统一重扫依赖这份清单（禁宿主在刷新时再传第二份路径）
    this.extraDirs.set(dir, tier);
    // 目录不存在时 scanMarkdownDir 返回空数组（首次使用前 .memora/skills 可能还没建，必须容忍）
    const entries = await scanMarkdownDir(dir);
    let count = 0;
    for (const entry of entries) {
      // 幂等：仅同一目录重复扫描才跳过；同名但来自不同目录必须走覆盖分支
      if (this.injectedFrom.get(entry.name) === dir) continue;

      const existing = this.items.find((s) => s.name === entry.name);
      const prevDir = this.injectedFrom.get(entry.name);
      const prevTier = prevDir ? this.extraDirs.get(prevDir) : undefined;
      // 顺序守卫（判据 SSOT = isOutOfOrderExtraTier，与角色包共用同一函数）
      if (existing && isOutOfOrderExtraTier(prevTier, tier)) {
        logger.warn(
          { name: entry.name, dir },
          '用户级技能晚于项目级加载，按 project > user 保持项目版',
        );
        continue;
      }

      const skill = await this.createEntry(entry);
      if (!skill) continue;

      if (existing) {
        // 覆盖：先摘旧项（deleteItem 注销 runtimeNames 记账，防止悬挂）
        this.deleteItem(entry.name);
        this.injectedFrom.delete(entry.name);
        if (prevDir) {
          // 被覆盖的是额外目录项：后加载者胜。项目覆盖用户 → 用户账撤销、项目账登记；
          // 同档（用户目录之间）覆盖 → 账仍归用户档（项目账不因用户目录改名而误留）
          if (tier === 'project') {
            this.userOverrides.delete(entry.name);
            this.projectOverrides.add(entry.name);
            logger.info(
              { name: entry.name, dir, prevDir },
              '项目技能覆盖用户级技能（project > user）',
            );
          } else {
            this.userOverrides.add(entry.name);
            this.projectOverrides.delete(entry.name);
            logger.info({ name: entry.name, dir, prevDir }, '用户技能覆盖先加载的用户技能');
          }
        } else if (tier === 'project') {
          this.projectOverrides.add(entry.name);
          logger.info({ name: entry.name, dir }, '项目技能覆盖内置技能');
        } else {
          this.userOverrides.add(entry.name);
          logger.info({ name: entry.name, dir }, '用户技能覆盖内置技能');
        }
      }
      this.registerRuntimeItem(skill);
      this.extraSkillNames.add(entry.name);
      this.injectedFrom.set(entry.name, dir);
      count++;
    }
    logger.info({ count, dir, tier }, '额外技能目录加载完成');
    return count;
  }

  /**
   * 覆盖声明：用户级**或**项目级覆盖的同名技能，reload 扫描回内置版时
   * 覆盖版胜出、内置版剔除（基类 retainRuntimeItems 消费）。其余同名不声明——
   * 保持基类默认「磁盘（内置）赢」语义（如 register() 运行时技能撞内置仍内置赢）。
   *
   * 两边取并集只为满足基类单一布尔位；分账口径仍由 userOverrideNames /
   * projectOverrideNames 两个快照各自表达（项目覆盖不计入用户覆盖）。
   */
  protected override isUserOverride(name: string): boolean {
    return this.userOverrides.has(name) || this.projectOverrides.has(name);
  }

  /**
   * load()（纯内置重载）后额外目录记账一并清空——与基类 runtimeNames 同寿命：
   * load() 整体替换 items、运行时注入全丢，账目须同步；否则残留名字会在未来
   * loadExtraDir 同名时被幂等跳过（见其开头判定），额外目录技能静默丢失。
   */
  protected override onAfterLoad(): void {
    this.clearExtraBookkeeping();
    // 目录登记与 items 同寿命：load() 整体替换 items 后须由宿主重新 loadExtraDir 注入
    this.extraDirs.clear();
  }

  // 返回类型钉死 `packageRoot: string`（编译期构造点守卫）：扫描器已保证，本处若漏传即 typecheck 红
  protected async createEntry(
    entry: ScannedMarkdownEntry,
  ): Promise<SkillEntry & { packageRoot: string }> {
    // L3 隔离纪律（对齐 Claude Code 主流）：仅「文件夹形态」（入口为 SKILL.md）才发现
    // resources/ scripts/。顶层裸 .md 单文件技能目录 = 技能池共享根，同级扫描会把别的技能的
    // resources/scripts 误归给自己 → 污染。故裸 .md 为纯 L1/L2，需要 L3 资源/脚本必须用文件夹+SKILL.md。
    //
    // 该规则与角色包内嵌技能**逐字同构**；发现与投影均已收口于 skillLayer3
    // （discoverSkillLayer3 + projectDiscoveredLayer3，SSOT）——两侧各写一遍投影，
    // 改一处即静默漂移。
    const discovered = await discoverSkillLayer3(entry.filePath);
    const layer3 = projectDiscoveredLayer3(discovered);

    return {
      name: entry.name,
      description: entry.frontmatter['description'],
      // 人类可读显示名（正文首个 H1）；UI 专用、不进 L1 模型清单。无 H1 则省略（展示面回退 name）。
      displayName: extractDisplayName(entry.body),
      content: entry.body.trim(),
      filePath: entry.filePath,
      // 资产包根（复制 / 迁移的唯一单元）由扫描分支直接给出（见 scanner.ScanMarkdownEntry.packageRoot）：
      // 目录式技能 = 技能目录（资源随包）；单文件技能 = 该文件本身。
      // 宿主据此整包复制，禁止拿 filePath 反推（单文件技能 dirname 会变成 skills/ 根，误搬兄弟技能）。
      packageRoot: entry.packageRoot,
      // 来源层（agent / project）：解析 frontmatter.layer，非法/缺失回退 project（与现状默认一致）。
      // ⚠️ 展示语义不由本字段单独决定：宿主以 filePath 前缀为主判据，
      // 本字段仅在无路径/未命中时兜底（project → 用户源，agent → 内置源）。
      layer: resolveLayer(entry.frontmatter['layer']),
      layer3,
    };
  }
}
