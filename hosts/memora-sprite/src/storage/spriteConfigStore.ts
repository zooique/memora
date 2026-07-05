/**
 * SpriteConfigStore — LLM 配置统一读写入口
 *
 * 职责：
 * - 统一管理 LLM 配置的读取、保存、完整性检查
 * - 确保读写路径一致（解决历史 bug：写入 ~/.memora-sprite/data/ 但读取 ~/.memora/）
 * - 封装 memora 核心库的 loadConfig，注入 sprite 专属配置路径
 *
 * 设计原则：
 * - 单一职责：仅管理 LLM 配置文件（config.json），不涉及 sprite.json
 * - 路径统一：所有读写都使用 DEFAULT_CONFIG_PATH，避免路径漂移
 * - 向前兼容：保留 configPath 可选参数，支持自定义路径（测试用）
 *
 * 目录分层：
 *   ~/.memora-sprite/
 *   ├── config.json      ← LLM 配置（根级）
 *   ├── sprite.json      ← 精灵配置（根级）
 *   ├── config/          ← Agent 级配置（rules/skills/personas）
 *   └── data/            ← 用户记忆（memora.db/workspace）
 *
 * 背景：
 *   原 saveLlmConfig 写入路径（~/.memora-sprite/data/config.json）与
 *   main.ts 中 loadConfig() 无参数调用的默认查找路径（~/.memora/ 或 .memora/）
 *   不一致，导致永远读不到 sprite 自己写的配置。提取此类统一管理路径。
 */
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { loadConfig, logger, toError } from 'memora';
import type { Config } from 'memora';
// P0-A：导入 SPRITE_HOME_DIR_NAME（路径真理源），消除硬编码重复
import { SPRITE_HOME_DIR_NAME } from '../sprite/constants.js';

/** 默认 LLM 配置文件路径（~/.memora-sprite/config.json） */
export const DEFAULT_CONFIG_PATH = resolve(homedir(), SPRITE_HOME_DIR_NAME, 'config.json');

/**
 * LLM 配置表单数据（设置面板读写用，storage 层持久化形态）
 *
 * 与渲染进程 LlmConfigForm 类型对齐，但存在以下分层差异（有意设计）：
 * - temperature 改为可选（storage 层允许省略，renderer 层表单必填）
 * - background.temperature 字段缺失（storage 层不持久化后台 temperature）
 * - background 仍为可选（保存时 background.enabled 决定是否写入）
 *
 * 分层原因：storage 层不应依赖 renderer 层，保留为独立类型。
 */
export interface LlmConfigFormData {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature?: number;
  /** 后台 Provider 配置（可选） */
  background?: {
    enabled: boolean;
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
  };
}

/**
 * Embedding 配置表单数据（storage 层持久化形态）
 *
 * 与渲染进程 EmbeddingConfigForm 类型对齐，但存在以下分层差异（有意设计）：
 * - enabled 字段缺失（storage 层用"参数是否传入"判断启用，参见 save() 签名 embeddingConfig?）
 * - baseUrl/apiKey 改为可选（storage 层允许省略，renderer 层表单必填）
 */
export interface EmbeddingConfigFormData {
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * LLM 配置存储器
 *
 * 统一管理 config.json 的读写，确保路径一致。
 * 所有配置操作都通过此类的实例进行，避免散落的 loadConfig() 调用。
 */
export class SpriteConfigStore {
  /** 配置文件路径（默认 ~/.memora-sprite/config.json） */
  private readonly configPath: string;

  /**
   * @param configPath 配置文件路径（默认使用 DEFAULT_CONFIG_PATH，测试可传入临时路径）
   */
  constructor(configPath: string = DEFAULT_CONFIG_PATH) {
    this.configPath = configPath;
  }

  /** 获取当前配置文件路径（供外部读取，如错误提示） */
  getPath(): string {
    return this.configPath;
  }

  /**
   * 加载 LLM 配置
   *
   * 委托 memora 核心库的 loadConfig，但显式传入 sprite 专属路径，
   * 确保读取的是 sprite 写入的配置文件。
   *
   * @returns Config 对象（memora 核心库类型）
   */
  async load(): Promise<Config> {
    return loadConfig(this.configPath);
  }

  /**
   * 检查 LLM 配置是否完整
   *
   * 判断标准：存在 apiKey 且 provider 不是 mock。
   * 供 Electron 启动时判断是否需要显示首次启动引导。
   *
   * @returns true 表示配置完整，false 表示需要引导
   */
  async isConfigured(): Promise<boolean> {
    try {
      const config = await this.load();
      return Boolean(config.llm.apiKey && config.llm.provider !== 'mock');
    } catch (err) {
      // 配置加载失败时判定为未配置，避免阻塞启动流程；记录警告便于排查
      logger.warn({ err: toError(err).message, configPath: this.configPath }, '配置加载失败，判定为未配置');
      return false;
    }
  }

  /**
   * 保存 LLM 配置
   *
   * 合并写入：读取现有配置，合并新配置，写回文件。
   * 保留其他字段（如 memory/security/allowedPaths），仅更新 llm 和 embedding。
   *
   * @param llmConfig LLM 配置表单数据
   * @param embeddingConfig 可选的 Embedding 配置
   */
  async save(
    llmConfig: LlmConfigFormData,
    embeddingConfig?: EmbeddingConfigFormData,
  ): Promise<void> {
    // 确保目录存在（首次运行时 dataDir 可能尚未创建）
    const dir = resolve(this.configPath, '..');
    await mkdir(dir, { recursive: true });

    // 读取现有配置（保留其他字段），不存在则用默认值
    let existing: Config;
    try {
      existing = await this.load();
    } catch (err) {
      // 读取失败时使用默认配置作为 fallback，记录警告便于排查
      logger.warn({ err: toError(err).message, configPath: this.configPath }, '读取现有配置失败，使用默认配置');
      existing = {
        llm: { provider: 'mock', model: 'mock-model', temperature: 0.7 },
        memory: { dataDir: '~/.memora-sprite/data', maxContextTokens: 120000 },
        security: { permission: 'owner', confirmWrites: false },
        allowedPaths: [],
      };
    }

    // 合并新配置
    const config: Config = {
      ...existing,
      llm: {
        ...existing.llm,
        provider: llmConfig.provider,
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl,
        apiKey: llmConfig.apiKey,
        temperature: llmConfig.temperature ?? existing.llm.temperature ?? 0.7,
        // 保存后台 Provider 配置（仅当 enabled 时写入）
        ...(llmConfig.background?.enabled ? {
          background: {
            provider: llmConfig.background.provider,
            model: llmConfig.background.model,
            baseUrl: llmConfig.background.baseUrl,
            apiKey: llmConfig.background.apiKey,
            temperature: 0.5, // 后台任务默认 temperature，偏低更稳定
          },
        } : {}),
      },
      ...(embeddingConfig ? { embedding: embeddingConfig } : {}),
    };

    // 设置 0600 权限：仅文件所有者可读写（防止 apiKey 泄露给同机其他用户）
    await writeFile(this.configPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  /**
   * 保存 Provider 映射表（多 Provider 管理专用）
   *
   * 合并写入：读取现有配置，更新 llm.providers 和 llm.active，
   * 保留其他字段不变。注意：providers 配置后，旧扁平字段仍保留用于降级。
   *
   * @param providers Provider 映射表（key → ProviderConfig）
   * @param active 当前激活的 Provider 别名
   * @param existing 现有的完整配置（避免重复读取，由调用方传入）
   */
  async saveProviders(
    providers: Record<string, { provider: string; model: string; baseUrl?: string; apiKey?: string }>,
    active: string,
    existing?: Config,
  ): Promise<void> {
    const dir = resolve(this.configPath, '..');
    await mkdir(dir, { recursive: true });

    const base = existing ?? await this.load().catch(() => ({
      llm: { provider: 'mock', model: 'mock-model', temperature: 0.7 },
      memory: { dataDir: '~/.memora-sprite/data', maxContextTokens: 120000 },
      security: { permission: 'owner' as const, confirmWrites: false },
      allowedPaths: [],
    }));

    const config: Config = {
      ...base,
      llm: {
        ...base.llm,
        providers,
        active,
      },
    };

    await writeFile(this.configPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
}

/** 默认配置存储器实例（单例，供 main.ts 直接使用） */
export const spriteConfigStore = new SpriteConfigStore();
