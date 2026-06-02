/**
 * 领域管理器 — M-208 领域切换
 *
 * 核心职责：
 *   - 管理多个 .memora/ 目录（每个"领域"一个）
 *   - 切换领域时重新加载所有组件（FileStore、MemoryIndex、TopicStore、SecurityGuard）
 *   - 旧域数据保留在磁盘，不销毁
 *
 * 设计原则：
 *   - 领域 = 目录路径，不引入额外概念
 *   - 切换 = 关闭旧连接 + 打开新连接，原子操作
 *   - 向量索引随领域切换（每个域独立的 vectors.json）
 *
 * 详见 ADR-008 · 目录结构按"职责分层"
 * 详见 记忆归档原则.md · 用户独特性原则（不同领域有不同记忆）
 */
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { FileStore } from '../memory/store.js';
import { MemoryIndex } from '../memory/index.js';
import { MemoryLoader } from '../memory/loader.js';
import { TopicStore } from '../memory/topic-store.js';
import { SecurityGuard } from '../security/path-guard.js';
import { logger } from '../logging/logger.js';
import type { Memory } from '../memory/types.js';
import type { Config } from '../config/loader.js';

/**
 * 领域上下文：切换领域后产出的一组新组件
 */
export interface DomainContext {
  /** 领域名称 */
  domainName: string;
  /** .memora/ 目录的绝对路径 */
  memoraDir: string;
  /** 文件存储 */
  fileStore: FileStore;
  /** SQLite 索引 */
  index: MemoryIndex;
  /** 话题存储 */
  topicStore: TopicStore;
  /** 安全守卫 */
  security: SecurityGuard;
  /** 启动时加载的必召记忆 */
  bootstrapMemories: Memory[];
  /** 加载结果 */
  loadResult: { loaded: number; skipped: number; errors: Array<{ file: string; error: string }> };
}

/**
 * 领域管理器
 *
 * 管理领域切换的生命周期：
 * 1. 初始化默认领域
 * 2. /domain <name> 切换到新领域
 * 3. 切换时关闭旧 SQLite 连接，创建新组件
 */
export class DomainManager {
  private currentDomain: string;
  private currentIndex: MemoryIndex | null = null;

  constructor(
    private readonly projectPath: string,
    private readonly config: Config,
  ) {
    // 默认领域 = 配置的 dataDir
    this.currentDomain = config.memory.dataDir;
  }

  /**
   * 获取当前领域名称
   */
  get currentDomainName(): string {
    return this.currentDomain;
  }

  /**
   * 初始化默认领域
   * @returns 领域上下文（包含所有组件）
   */
  async initDefault(): Promise<DomainContext> {
    return this.initDomain(this.currentDomain);
  }

  /**
   * 切换领域
   * @param domainName 领域名称（对应 .memora-<name>/ 目录）
   * @returns 新领域的上下文
   */
  async switchDomain(domainName: string): Promise<DomainContext> {
    // 关闭旧 SQLite 连接
    if (this.currentIndex) {
      await this.currentIndex.close().catch((err) => logger.warn({ err }, '关闭旧领域数据库失败'));
    }

    this.currentDomain = domainName;
    logger.info({ domain: domainName }, '切换领域');

    return this.initDomain(domainName);
  }

  /**
   * 列出可用的领域
   * 扫描项目根目录下的 .memora* 目录
   */
  listDomains(): string[] {
    const domains: string[] = [];
    // 默认领域
    if (existsSync(resolve(this.projectPath, '.memora'))) {
      domains.push('default');
    }
    // 其他领域：.memora-<name>/
    try {
      const entries = readdirSync(this.projectPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('.memora-')) {
          domains.push(entry.name.slice('.memora-'.length));
        }
      }
    } catch {
      // 项目目录不可读，只返回默认
    }
    return domains;
  }

  /**
   * 初始化指定领域的所有组件
   */
  private async initDomain(domainName: string): Promise<DomainContext> {
    const memoraDir = this.resolveMemoraDir(domainName);

    // 确保目录存在
    mkdirSync(memoraDir, { recursive: true });

    // 初始化组件
    const fileStore = new FileStore(memoraDir);
    const dbPath = join(memoraDir, 'memora.db');
    const index = new MemoryIndex(dbPath);
    this.currentIndex = index;

    // 加载记忆
    const loader = new MemoryLoader(fileStore, index);
    const { memories: bootstrapMemories, loadResult } = await loader.bootstrap();

    // 话题存储
    const topicStore = new TopicStore(memoraDir);

    // 安全守卫
    const security = new SecurityGuard(
      this.projectPath,
      memoraDir,
      this.config.allowedPaths,
      this.config.security.confirmWrites,
      this.config.security.permission,
    );

    logger.info(
      {
        domain: domainName,
        memoraDir,
        loaded: loadResult.loaded,
        bootstrapCount: bootstrapMemories.length,
      },
      '领域初始化完成',
    );

    return {
      domainName,
      memoraDir,
      fileStore,
      index,
      topicStore,
      security,
      bootstrapMemories,
      loadResult,
    };
  }

  /**
   * 根据领域名称解析 .memora/ 目录路径
   * - "default" 或原始 dataDir → config.memory.dataDir（~ 展开）
   * - 其他 → projectPath/.memora-<name>/
   */
  private resolveMemoraDir(domainName: string): string {
    if (domainName === 'default' || domainName === this.config.memory.dataDir) {
      // 尊重 config 中的 ~ 展开
      return resolve(this.config.memory.dataDir.replace(/^~/, homedir()));
    }
    return resolve(this.projectPath, `.memora-${domainName}`);
  }
}
