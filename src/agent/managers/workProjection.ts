/**
 * 作品投影管理 — 用户作品的「极简指针索引」（JSON 单文件存储）
 *
 * 定位：AI 工作前的项目地图——告诉 AI 项目里有哪些关键文件。
 * 存储：<memoraDir>/work-projections.json，JSON 数组。
 * 逻辑：只做索引，不存内容。source 指向真实文件，AI 按需 read_file 读取。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '@/logging/logger.js';
import { getBaseName } from '@/utils/path.js';
import { resolveSafePath } from '@/utils/scanner.js';
import { atomicWriteFile } from '@/utils/atomicWrite.js';

/** 投影文件名（位于 memoraDir 下） */
const PROJECTIONS_FILE = 'work-projections.json';

/** 装配注入块的标题前缀（常量，便于统一修改与国际化扩展） */
const CONTEXT_BLOCK_HEADER = '【项目索引】';

/** 装配注入块的提示文本（常量，便于统一修改与国际化扩展） */
const CONTEXT_BLOCK_FOOTER =
  '（项目关键文件指针。如需详细内容，请使用 read_file 读取对应 source 路径。）';

/**
 * 作品投影的极简结构（纯元数据指针）
 */
export interface WorkProjectionEntry {
  /** 作品名（默认取源文件名去扩展名） */
  name: string;
  /** 一句话说明（告诉 AI 这个文件是干什么的） */
  description: string;
  /** 源文件路径（相对项目根，指向真实文件） */
  source: string;
}

/**
 * 作品投影管理器：极简索引读写
 *
 * 并发说明：当前为单 Agent 单进程场景，registerWork 无文件锁保护。
 * 如需多进程/多线程并发写支持，需在此扩展文件锁机制（如 proper-lockfile）。
 */
export class WorkProjectionManager {
  /** 投影文件路径（<memoraDir>/work-projections.json） */
  private readonly filePath: string;
  /** 项目根目录（用于路径穿越防御，可选） */
  private readonly projectDir?: string;
  /** 投影登记回调（宿主通知用，可选） */
  private readonly onGenerated?: (sourcePath: string, description: string) => void;
  /** 已加载投影缓存（refresh() 同步自磁盘，contextBlock() 读取此缓存） */
  private entries: WorkProjectionEntry[] = [];
  /** 最近一次 refresh 是否检出「文件存在但格式错误」（非数组根/损坏），用于 registerWork fail-safe 防覆盖 */
  private fileWasMalformed = false;

  /**
   * @param memoraDir 项目级 .memora/ 目录
   * @param onGenerated 投影登记回调（宿主通知用，可选）
   * @param projectDir 项目根目录（用于路径穿越防御，可选）
   */
  constructor(
    memoraDir: string,
    onGenerated?: (sourcePath: string, description: string) => void,
    projectDir?: string,
  ) {
    this.filePath = join(memoraDir, PROJECTIONS_FILE);
    this.onGenerated = onGenerated;
    this.projectDir = projectDir;
  }

  /**
   * 查询投影文件格式是否异常（只读状态）
   *
   * 用于调用方区分「无投影条目」与「投影文件格式错误被跳过」两种情况：
   * - true：文件存在但格式非顶层 JSON 数组或损坏，registerWork 会拒绝写入以防覆盖
   * - false：文件格式正常或不存在（空项目）
   */
  get isFileMalformed(): boolean {
    return this.fileWasMalformed;
  }

  /**
   * 登记作品索引（register_work 工具数据源）
   *
   * 向 JSON 数组追加/更新一条记录。同名 source 会被覆盖。
   *
   * @param sourcePath 源文件路径（相对项目根）
   * @param description 作品的一句话说明
   * @returns 登记成功的投影条目；失败返回 null
   */
  async registerWork(sourcePath: string, description: string): Promise<WorkProjectionEntry | null> {
    // 路径穿越防御：验证 sourcePath 不越界
    if (this.projectDir && resolveSafePath(this.projectDir, sourcePath) === null) {
      logger.warn({ sourcePath }, '作品投影登记失败：source 路径越界');
      return null;
    }

    // 提取作品名（文件名去扩展名；getBaseName 返回带扩展名末段，故需补一次去扩展名）
    const baseName = getBaseName(sourcePath).replace(/\.[^.]+$/, '') || 'unknown';

    const newEntry: WorkProjectionEntry = {
      name: baseName,
      description: normalizeDescription(description),
      source: toSingleLine(sourcePath),
    };

    try {
      // 读取现有数据（如果文件存在）
      await this.refresh();

      // fail-safe：预存文件格式错误（非数组根/损坏）时不覆盖写盘，避免丢失用户原索引
      // （与路径越界守卫同构：不可解析的文件不擅自改写）
      if (this.fileWasMalformed) {
        logger.warn(
          { file: this.filePath },
          '作品投影登记中止：预存文件格式错误，已跳过以免覆盖原索引；请修正为顶层 JSON 数组后重试',
        );
        return null;
      }

      // 检查是否已存在相同 source，存在则更新，不存在则追加
      const existingIndex = this.entries.findIndex((e) => e.source === newEntry.source);
      if (existingIndex >= 0) {
        this.entries[existingIndex] = newEntry;
      } else {
        this.entries.push(newEntry);
      }

      await mkdir(dirname(this.filePath), { recursive: true });
      await atomicWriteFile(this.filePath, JSON.stringify(this.entries, null, 2));

      logger.info({ file: sourcePath, name: newEntry.name }, '作品投影已登记');
      this.onGenerated?.(sourcePath, newEntry.description);

      return newEntry;
    } catch (err) {
      logger.warn({ err, file: sourcePath }, '作品投影登记失败');
      return null;
    }
  }

  /**
   * 从磁盘加载投影数据
   *
   * @returns 当前全部投影条目
   */
  async refresh(): Promise<WorkProjectionEntry[]> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      // 验证数据格式（必须是顶层数组，与设计文档 docs/architecture/work-projection.md 一致）
      if (Array.isArray(parsed)) {
        this.fileWasMalformed = false;
        this.entries = parsed.filter((e) => e && e.source && e.name);
      } else {
        // 非数组根（如 {"entries":[...]} 错形态）→ 读路径不静默清空、显式告警；
        // 写路径由 registerWork 经 fileWasMalformed 标志 fail-safe 中止，不覆盖用户原索引
        logger.warn(
          { file: this.filePath },
          '作品投影文件根节点非数组，已忽略（预期顶层 JSON 数组；若照旧文档手写请改为 [...]，详见 docs/architecture/work-projection.md）',
        );
        this.fileWasMalformed = true;
        this.entries = [];
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        // 文件不存在（尚未登记任何作品）→ 视为空，可安全写入
        logger.debug({ err }, '作品投影文件不存在，返回空');
      } else {
        // 文件存在但读取/解析失败（损坏或非法 JSON）→ 标记错形态，交 registerWork fail-safe 拦截，不覆盖原文件
        logger.warn({ err, file: this.filePath }, '作品投影文件读取或解析失败，暂不加载原内容');
        this.fileWasMalformed = true;
      }
      this.entries = [];
    }
    return this.entries;
  }

  /**
   * 获取全部作品投影
   *
   * @returns 全部投影条目的副本
   */
  async listWorks(): Promise<WorkProjectionEntry[]> {
    return this.refresh();
  }

  /**
   * 装配注入块（极简元数据清单）
   *
   * 仅注入 name + description + source 清单，不注入任何正文。
   * AI 根据 description 判断相关性，自主 read_file 读取原文。
   *
   * 注意：此方法读取内存缓存（上一次 refresh() 同步的结果）。
   * 若需从磁盘强制刷新，请使用 loadAndGetContextBlock()。
   *
   * @returns 装配注入文本块；无投影时为空串
   */
  contextBlock(): string {
    if (this.entries.length === 0) return '';

    const parts: string[] = [CONTEXT_BLOCK_HEADER];
    for (const e of this.entries) {
      parts.push(`- ${e.name}：${e.description} (源: ${e.source})`);
    }
    parts.push('');
    parts.push(CONTEXT_BLOCK_FOOTER);

    return parts.join('\n');
  }

  /**
   * SSOT 读取路径：从磁盘刷新后返回装配注入块
   *
   * 将 refresh() + contextBlock() 合为单一操作，消除调用方"先刷新再读取"的时序依赖。
   * 装配层和需要实时数据的场景应使用此方法，而非分别调用 refresh() 和 contextBlock()。
   *
   * @returns 装配注入文本块；刷新失败或无投影时为空串
   */
  async loadAndGetContextBlock(): Promise<string> {
    try {
      await this.refresh();
    } catch (err) {
      // 刷新失败（如文件损坏/权限异常）时记录日志并降级为空串，不阻断装配主流程
      // refresh() 内部已将 entries 重置为空 + 标记 fileWasMalformed，此处仅补充上下文日志
      logger.warn({ err, file: this.filePath }, '作品投影 SSOT 读取路径刷新失败，降级为空索引');
    }
    return this.contextBlock();
  }
}

/**
 * 单行化处理：折叠换行为空格，防止格式注入
 */
function toSingleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

/**
 * 描述归一化：单行化 + 限长截断
 *
 * 内核统一归一层，防止 system prompt 膨胀。不在此调 LLM（内核零三方依赖、不持 provider），
 * 超长仅硬截断并加省略号。
 */
const MAX_DESCRIPTION_LENGTH = 100;

function normalizeDescription(value: string): string {
  const single = toSingleLine(value);
  if (single.length <= MAX_DESCRIPTION_LENGTH) return single;
  return single.slice(0, MAX_DESCRIPTION_LENGTH) + '…';
}
