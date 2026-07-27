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
import { mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
// safeWriteJson 统一 JSON 写入 + 0o600 权限保护（ADR-017 枝叶层 2 次提取）
import { safeWriteJson } from '../shared/safeWriteJson.js';
import { homedir } from 'node:os';
import { loadConfig, logger, toError } from 'memora';
import type { Config } from 'memora';
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
   * 加载 LLM 配置，文件缺失时返回 sprite 专属默认配置
   *
   * 与 load() 的区别：load() 在文件缺失时抛错；loadOrDefault() 返回默认值。
   * 供"读取现有配置以合并写入"的场景使用（如 saveLlmProvider），
   * 避免首次添加 Provider 时因 config.json 不存在而失败。
   *
   * @returns Config 对象（文件存在时为实际配置，不存在时为默认配置）
   */
  async loadOrDefault(): Promise<Config> {
    try {
      return await this.load();
    } catch (err) {
      // ENOENT 是合法状态（首次启动/配置缺失），不备份
      // 其他错误（JSON 损坏、权限等）备份原文件再返回默认值，避免后续 save() 覆盖损坏文件
      const errno = err as NodeJS.ErrnoException;
      if (errno.code !== 'ENOENT' && existsSync(this.configPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${this.configPath}.corrupted.${ts}`;
        try {
          await rename(this.configPath, backupPath);
          logger.warn({ err: toError(err).message, configPath: this.configPath, backupPath }, '配置文件损坏，已备份原文件并使用默认配置');
        } catch {
          logger.warn({ err: toError(err).message, configPath: this.configPath }, '配置文件损坏且备份失败，使用默认配置');
        }
      } else if (errno.code !== 'ENOENT') {
        logger.warn({ err: toError(err).message, configPath: this.configPath }, '读取现有配置失败，使用默认配置');
      }
      return {
        llm: { provider: 'mock', model: 'mock-model', temperature: 0.7 },
        memory: { dataDir: '~/.memora-sprite/data', maxContextTokens: 120000 },
        security: { permission: 'owner', confirmWrites: false },
        allowedPaths: [],
      };
    }
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
      // 读取激活 Provider 判定，兼容 v1.x 遗留扁平配置（兜底到 default）
      const providers = config.llm.providers ?? {};
      const active = config.llm.active ?? Object.keys(providers)[0] ?? 'default';
      const provider = resolveProviderConfig(config, active) ?? resolveProviderConfig(config, 'default');
      return Boolean(provider?.apiKey && provider.provider !== 'mock');
    } catch (err) {
      // ENOENT 是合法状态（首次启动/配置缺失），静默判定为未配置不记 warn
      // 其他错误（权限/JSON 损坏等）仍记 warn 便于排查
      const errno = err as NodeJS.ErrnoException;
      if (errno.code !== 'ENOENT') {
        logger.warn({ err: toError(err).message, configPath: this.configPath }, '配置加载失败，判定为未配置');
      }
      return false;
    }
  }

  /**
   * 保存 LLM 配置
   *
   * 合并写入：读取现有配置，合并新配置，写回文件。
   * 保留其他字段（如 memory/security/allowedPaths），仅更新 llm 和 embedding。
   * 同时保留 providers/active 字段（多 Provider 管理专用），避免互相覆盖。
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
    const existing = await this.loadOrDefault();

    // 单配置表单统一收敛到 providers['default'] 别名，使配置文件始终为
    // providers+active 单一格式（内核以 providers[active] 为真理源，
    // 旧扁平 provider/model/apiKey 已废弃，不再写入）。
    const providers = { ...(existing.llm.providers ?? {}) };
    providers['default'] = {
      provider: llmConfig.provider,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl || undefined,
      apiKey: llmConfig.apiKey,
      temperature: llmConfig.temperature ?? existing.llm.providers?.['default']?.temperature ?? 0.7,
    };

    const config: Config = {
      ...existing,
      llm: {
        ...existing.llm,
        providers,
        active: existing.llm.active ?? 'default',
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

    // safeWriteJson 统一处理 JSON 写入 + 0o600 权限（防止 apiKey 泄露给同机其他用户）
    await safeWriteJson(this.configPath, config);
  }

  /**
   * 保存 Provider 映射表（多 Provider 管理专用）
   *
   * 合并写入：基于调用方传入的现有配置，更新 llm.providers 和 llm.active，
   * 同时同步更新扁平字段（provider/model/baseUrl/apiKey/temperature）用于向后兼容。
   *
   * @param providers Provider 映射表（key → ProviderConfig）
   * @param active 当前激活的 Provider 别名
   * @param existing 现有的完整配置（由调用方传入，避免重复读取）
   */
  async saveProviders(
    providers: Record<string, { provider: string; model: string; baseUrl?: string; apiKey?: string; temperature?: number }>,
    active: string,
    existing: Config,
  ): Promise<void> {
    const dir = resolve(this.configPath, '..');
    await mkdir(dir, { recursive: true });

    // 配置文件已收敛为 providers+active 单一格式，不再回填扁平字段
    // （内核以 providers[active] 为真理源，扁平 provider/model 已废弃）。
    // providers 整体替换 existing（不合并未传入的 key），以保证 deleteLlmProvider 的删除语义正确；
    // 对映射中缺失 temperature 的 key，回退到 existing 同 key 的值，避免编辑时丢失已配置温度。
    const mergedProviders = Object.fromEntries(
      Object.entries(providers).map(([key, p]) => [
        key,
        { ...p, temperature: p.temperature ?? existing.llm.providers?.[key]?.temperature },
      ]),
    );

    const config: Config = {
      ...existing,
      llm: {
        ...existing.llm,
        providers: mergedProviders,
        active,
      },
    };

    await safeWriteJson(this.configPath, config);
  }

  /**
   * 保存后台 Provider 选择
   *
   * 从 providers 映射表中解析完整配置，写入 llm.background。
   * backgroundKey 为 null 或空字符串时清除 background 配置（回退到"与实时对话相同"）。
   *
   * 消费点：providerManagement UI 下拉框 change 事件 → IPC → 此方法
   * 下游：index.ts 启动时读取 llm.background 注入 agent.setBackgroundProvider
   *
   * @param backgroundKey Provider 别名（空字符串/null 表示清除）
   */
  async saveBackgroundProvider(
    backgroundKey: string | null,
  ): Promise<void> {
    const dir = resolve(this.configPath, '..');
    await mkdir(dir, { recursive: true });

    const existing = await this.loadOrDefault();
    const config: Config = { ...existing };

    if (backgroundKey && existing.llm.providers?.[backgroundKey]) {
      const provider = existing.llm.providers[backgroundKey];
      config.llm = {
        ...existing.llm,
        background: {
          provider: provider.provider,
          model: provider.model,
          baseUrl: provider.baseUrl ?? '',
          apiKey: provider.apiKey ?? '',
          temperature: 0.5, // 后台任务默认 temperature，偏低更稳定
        },
      };
    } else {
      // 清除 background 配置（回退到"与实时对话相同"，无 bgProvider）
      config.llm = {
        ...existing.llm,
      };
      delete config.llm.background;
    }

    await safeWriteJson(this.configPath, config);
  }
}

/** 默认配置存储器实例（单例，供 main.ts 直接使用） */
export const spriteConfigStore = new SpriteConfigStore();

/**
 * 从配置中解析 Provider 配置
 *
 * 配置文件以 providers+active 为单一格式：
 * - config.llm.providers = { "key": { provider, model, baseUrl, apiKey, temperature } }
 * - config.llm.active 为当前激活的 key
 *
 * 仅按 key 读取 providers 映射表；不存在返回 undefined。
 * （v1.x 遗留扁平配置兼容分支已移除——项目从未正式发布，
 *  仅作者单人开发测试，旧扁平文件直接重新引导即可。）
 *
 * @param config 完整配置对象
 * @param key Provider 别名
 * @returns Provider 配置（含 apiKey 明文），找不到时返回 undefined
 */
export function resolveProviderConfig(
  config: Config,
  key: string,
): { provider: string; model: string; baseUrl?: string; apiKey?: string; temperature?: number } | undefined {
  return config.llm.providers?.[key];
}
