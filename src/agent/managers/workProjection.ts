/**
 * 作品投影管理 — 用户作品的「极简指针索引」（JSON 单文件存储）
 *
 * 定案（2026-08-26 剪枝重构）：
 * 从「Markdown 多文件 + Frontmatter + 两级披露」简化为「JSON 单文件 + 纯元数据指针」。
 * 回归核心定位：AI 工作前的项目地图——告诉 AI 项目里有哪些关键文件。
 *
 * 存储：<memoraDir>/work-projections.json，JSON 数组。
 * 逻辑：只做索引，不存内容。source 指向真实文件，AI 按需 read_file 读取。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/logging/logger.js';
import { getBaseName } from '@/utils/path.js';
import { resolveSafePath } from '@/utils/scanner.js';
import { atomicWriteFile } from '@/utils/atomicWrite.js';

/** 投影文件名（位于 memoraDir 下） */
const PROJECTIONS_FILE = 'work-projections.json';

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
 */
export class WorkProjectionManager {
  /** 投影文件路径（<memoraDir>/work-projections.json） */
  private readonly filePath: string;
  /** 项目根目录（用于路径穿越防御，可选） */
  private readonly projectDir?: string;
  /** 投影登记回调（宿主通知用，可选） */
  private readonly onGenerated?: (sourcePath: string, description: string) => void;
  /** 已加载投影缓存 */
  private entries: WorkProjectionEntry[] = [];

  /**
   * @param memoraDir 项目级 .memora/ 目录
   * @param onGenerated 投影登记回调（宿主通知用，可选）
   * @param projectDir 项目根目录（用于路径穿越防御，可选）
   */
  constructor(memoraDir: string, onGenerated?: (sourcePath: string, description: string) => void, projectDir?: string) {
    this.filePath = join(memoraDir, PROJECTIONS_FILE);
    this.onGenerated = onGenerated;
    this.projectDir = projectDir;
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

    // 提取作品名（文件名去扩展名）
    const baseName = getBaseName(sourcePath).replace(/\.[^.]+$/, '') || 'unknown';
    
    const newEntry: WorkProjectionEntry = {
      name: baseName,
      description: toSingleLine(description),
      source: toSingleLine(sourcePath),
    };

    try {
      // 读取现有数据（如果文件存在）
      await this.refresh();
      
      // 检查是否已存在相同 source，存在则更新，不存在则追加
      const existingIndex = this.entries.findIndex(e => e.source === newEntry.source);
      if (existingIndex >= 0) {
        this.entries[existingIndex] = newEntry;
      } else {
        this.entries.push(newEntry);
      }

      await mkdir(join(this.filePath, '..'), { recursive: true });
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
        this.entries = parsed.filter(e => e && e.source && e.name);
      } else {
        // 非数组根（如 {"entries":[...]} 错形态）→ 不静默清空，显式告警以暴露格式错误，
        // 避免用户手写的索引被后续 register_work 覆盖丢失（见作品投影"找茬"复盘）
        logger.warn(
          { file: this.filePath },
          '作品投影文件根节点非数组，已忽略（预期顶层 JSON 数组；若照旧文档手写请改为 [...]，详见 docs/architecture/work-projection.md）',
        );
        this.entries = [];
      }
    } catch (err) {
      // 文件不存在（尚未登记任何作品）→ 视为空
      logger.debug({ err }, '作品投影文件不存在或解析失败，返回空');
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
   * @returns 装配注入文本块；无投影时为空串
   */
  contextBlock(): string {
    if (this.entries.length === 0) return '';
    
    const parts: string[] = ['【项目索引】'];
    for (const e of this.entries) {
      parts.push(`- ${e.name}：${e.description} (源: ${e.source})`);
    }
    parts.push('');
    parts.push('（项目关键文件指针。如需详细内容，请使用 read_file 读取对应 source 路径。）');
    
    return parts.join('\n');
  }
}

/**
 * 单行化处理：折叠换行为空格，防止格式注入
 */
function toSingleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}