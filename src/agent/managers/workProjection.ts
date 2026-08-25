/**
 * 作品投影管理 — 用户作品的「索引卡片」（markdown + frontmatter）
 *
 * 定案（2026-08-25 方案 C，见 docs/architecture/work-projection.md）：
 * 从「read_file 自动生成浓缩摘要（JSON + hash）」改为「用户主动触发的索引
 * （name + description + 可选 source + mode 必读开关）」。
 *
 * 存储：项目级目录（<memoraDir>/projections/<slug>.md），markdown frontmatter，
 * 对齐 skill 存储格式——复用 scanMarkdownDir + parseFrontmatter，用户可用
 * VSCode 直接编辑/删除（不做专属 UI 视图，VSCode 编辑器即 UI）。
 *
 * source 约定：显式值 = 相对项目根的源文件路径（指向外部文件）；缺省 = 自指
 * （这份投影文件本身就是被投影的文档，正文即内容）。投影始终是「一份文档的
 * 入口」——指向外部或指向自己之别，不引入规则/设定等新语义类别
 * （因此不触碰 role-pack boundary 的「设定记忆唯一归角色包」纪律）。
 *
 * 装配注入（两级渐进披露，与 skills 同构）：
 *   - L1：所有卡片 name + description 清单常驻（contextBlock）
 *   - L2：mode:always 卡片额外出正文；source 指向的外部原文不灌入
 * registerWork 写卡片后刷新缓存，contextBlock 同步读取缓存。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/logging/logger.js';
import { slugify } from '@/utils/strings.js';
import { getBaseName } from '@/utils/path.js';
import { scanMarkdownDir, resolveSafePath } from '@/utils/scanner.js';
import { serializeFrontmatter } from '@/utils/frontmatter.js';
import { atomicWriteFile } from '@/utils/atomicWrite.js';

/** 投影文件子目录名（位于 memoraDir 下，与 rules/skills 并列） */
const PROJECTIONS_SUBDIR = 'projections';

/** 必读开关：always = 必读（装配时注入正文）/ on-demand = 按需（默认） */
export type ProjectionMode = 'always' | 'on-demand';

/**
 * 作品投影的持久化结构（markdown frontmatter 映射）
 *
 * name/description/source/mode 与 frontmatter 四字段一一对应；
 * body/filePath 为加载时派生的读取态字段（不落 frontmatter）。
 */
export interface WorkProjectionEntry {
  /** 作品名（默认取源文件名去扩展名；用户可手改） */
  name: string;
  /** 一句话说明（LLM 生成，用户可手改；兼「按需拉取的匹配依据」） */
  description: string;
  /** 源文件路径（可选，相对项目根；缺省 = 自指，正文即内容） */
  source?: string;
  /** 必读开关（always 必读 / on-demand 按需，默认 on-demand） */
  mode?: ProjectionMode;
  /** 正文（source 缺省时即文档内容；L2 装配注入用，加载时派生） */
  body: string;
  /** 投影文件绝对路径（加载时派生，宿主「打开作品文件」入口用） */
  filePath: string;
}

/**
 * 作品投影管理器：用户主动触发的作品索引（写 md 卡片 + 扫描读取 + 装配注入块）
 *
 * 定位：agent/ 层，但**不再依赖 LLM Provider**——description 由 LLM 经
 * register_work 工具参数传入，管理器只做纯文件索引读写（用户主动登记 +
 * 用户直接改文件，双层用户控制面）。
 */
export class WorkProjectionManager {
  /** 投影文件目录（<memoraDir>/projections），项目级、随项目隔离 */
  private readonly projectionsDir: string;
  /** 项目根目录（用于路径穿越防御，可选） */
  private readonly projectDir?: string;
  /** 投影登记回调（宿主据此发射事件，可选） */
  private readonly onGenerated?: (sourcePath: string, description: string) => void;
  /** 已加载投影缓存（contextBlock 同步读取；registerWork/refresh 时更新） */
  private entries: WorkProjectionEntry[] = [];

  /**
   * @param memoraDir 项目级 .memora/ 目录（投影存 <memoraDir>/projections/，随项目隔离）
   * @param onGenerated 投影登记回调（宿主通知用，可选）
   * @param projectDir 项目根目录（用于路径穿越防御，可选）
   */
  constructor(memoraDir: string, onGenerated?: (sourcePath: string, description: string) => void, projectDir?: string) {
    this.projectionsDir = join(memoraDir, PROJECTIONS_SUBDIR);
    this.onGenerated = onGenerated;
    this.projectDir = projectDir;
  }

  /**
   * 登记作品索引卡片（register_work 工具数据源）
   *
   * 写 <projectionsDir>/<slug>.md：name 取源文件名去扩展名、带 source、
   * mode 默认 on-demand（指向外部文件的索引卡片）。同名 slug 后写覆盖。
   * 写成功后刷新缓存并触发 onGenerated；失败降级返回 null（不抛错）。
   *
   * @param sourcePath 源文件路径（相对项目根）
   * @param description 作品的一句话说明（LLM 总结，用户可后续手改）
   * @returns 登记成功的投影条目；失败返回 null
   */
  async registerWork(sourcePath: string, description: string): Promise<WorkProjectionEntry | null> {
    // 路径穿越防御：若 projectDir 可用，验证 sourcePath 不越界
    if (this.projectDir && resolveSafePath(this.projectDir, sourcePath) === null) {
      logger.warn({ sourcePath }, '作品投影登记失败：source 路径越界');
      return null;
    }
    // 源文件名去扩展名 → 作品名 → slug 文件名（frontmatter 值单行化防注入格式）
    const baseName = getBaseName(sourcePath).replace(/\.[^.]+$/, '') || 'unknown';
    const name = toSingleLine(baseName);
    const safeDescription = toSingleLine(description);
    const filePath = join(this.projectionsDir, `${slugify(name)}.md`);

    // frontmatter 序列化：source/mode 显式写入（缺省 = 自指由用户手写时省略）
    const frontmatter = serializeFrontmatter({
      name,
      description: safeDescription,
      source: toSingleLine(sourcePath),
      mode: 'on-demand',
    });
    const md = `---\n${frontmatter}\n---\n`;

    try {
      // 目录保证存在 + 原子写（rename 原子替换，防写半截损坏卡片）
      await mkdir(this.projectionsDir, { recursive: true });
      await atomicWriteFile(filePath, md);
      // 刷新缓存（并入新登记卡片，contextBlock 立即生效）
      await this.refresh();
      logger.info({ file: sourcePath, name }, '作品投影已登记');
      // 回调接收已净化（单行化）的 description，防止换行注入
      this.onGenerated?.(sourcePath, safeDescription);
      // 返回登记结果（filePath 供工具结果告知用户编辑位置）
      return { name, description: safeDescription, source: sourcePath, mode: 'on-demand', body: '', filePath };
    } catch (err) {
      logger.warn({ err, file: sourcePath }, '作品投影登记失败');
      return null;
    }
  }

  /**
   * 重新扫描投影目录并刷新缓存
   *
   * registerWork 自动调用；用户直接编辑/删除卡片后也可显式调用。
   * 目录不存在（尚未登记任何作品）→ 视为空，不阻塞。
   *
   * @returns 当前全部投影条目
   */
  async refresh(): Promise<WorkProjectionEntry[]> {
    try {
      const scanned = await scanMarkdownDir(this.projectionsDir);
      this.entries = scanned.map((s) => ({
        name: s.frontmatter['name'] ?? s.name,
        description: s.frontmatter['description'] ?? '',
        source: s.frontmatter['source'] || undefined,
        mode: s.frontmatter['mode'] === 'always' ? 'always' : 'on-demand',
        body: s.body,
        filePath: s.filePath,
      }));
    } catch (err) {
      // 目录不存在（项目尚未登记任何作品）→ 视为无投影，不阻塞
      logger.debug({ err }, '作品投影目录不存在，返回空');
      this.entries = [];
    }
    return this.entries;
  }

  /**
   * 加载项目目录下所有作品投影（扫描 projections/ 子目录）
   *
   * 宿主「列作品清单」入口的数据源；等价于 refresh()——**每次调用都触发磁盘扫描**。
   * 若仅需读取当前缓存（不触发扫描），应先调用 refresh() 再使用 entries。
   *
   * @returns 全部投影条目
   */
  async listWorks(): Promise<WorkProjectionEntry[]> {
    return this.refresh();
  }

  /**
   * 装配注入块（两级渐进披露，同步读取缓存）
   *
   * L1：所有卡片 name + description 清单常驻（超轻量「指针索引」，让 LLM 知道
   * 「有哪些作品、各自是什么」）；L2：mode:always 卡片额外出正文。
   * source 指向的外部原文不灌入（按需 read_file 读取，保证单一真理源）。
   * 缓存为空（尚未 refresh）时返回空串。
   *
   * @returns 装配注入文本块；无投影时为空串
   */
  contextBlock(): string {
    if (this.entries.length === 0) return '';
    const parts: string[] = ['【作品投影】'];
    // L1：所有卡片 name + description 清单
    for (const e of this.entries) {
      const sourceHint = e.source ? `（源：${e.source}）` : '';
      const modeHint = e.mode === 'always' ? ' [必读]' : '';
      parts.push(`- ${e.name}：${e.description}${sourceHint}${modeHint}`);
    }
    // L2：always 卡片额外出正文（轻量；不灌 source 指向的外部原文）
    const always = this.entries.filter((e) => e.mode === 'always' && e.body);
    if (always.length > 0) {
      parts.push('');
      for (const e of always) {
        parts.push(`[必读作品：${e.name}]`);
        parts.push(e.body);
      }
    }
    return parts.join('\n');
  }
}

/**
 * frontmatter 值单行化：折叠换行为空格，防换行注入破坏 `key: value` 结构
 *
 * @param value 原始值
 * @returns 单行化后的值
 */
function toSingleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}
