/**
 * 大模型 Provider 存储层 — 多 Provider 配置的持久化与连接测试
 *
 * 职责：
 *   - 非敏感字段（name/displayName/model/baseUrl/provider）存 VS Code configuration
 *     （写入工作区 settings.json 的 memora.providers）
 *   - 敏感字段 apiKey 存 SecretStorage（加密存储，不落盘 settings.json）
 *   - activeProvider 记录当前激活的 Provider name
 *   - 连接测试复用内核 createProviderFromConfig + chat()
 *
 * 设计（对齐 memora-sprite 的多 Provider 管理 + 单一真理源）：
 *   - apiKey 用 SecretStorage 而非 configuration，避免 key 被 git 提交
 *   - key 命名 `memora.provider.{name}.apiKey`，以 name 为唯一键
 *   - 编辑时 apiKey 允许留空 = 保留原值（由 save 的 isEditing 语义处理）
 */
import * as vscode from 'vscode';
import { createProviderFromConfig } from '@zooique/memora';
import type { LlmProviderConfig } from '../../shared/protocol.js';

/** configuration 段名（memora.providers） */
const CFG_SECTION = 'memora';
/** providers 数组配置键 */
const CFG_PROVIDERS = 'providers';
/** activeProvider 配置键 */
const CFG_ACTIVE = 'activeProvider';
/** SecretStorage apiKey key 前缀 */
const SECRET_PREFIX = 'memora.provider';

/** 脱敏占位符（apiKey 为空或已配置时展示） */
const MASK = '••••••••';

/**
 * 生成 API Key 的脱敏展示串（仅用于编辑回显，绝不回传真实值）
 *
 * 规则：保留前 3 位 + 4 个掩码点 + 后 4 位（如 `sk-••••1234`）；
 * 长度不足 8 位时整体掩码。
 *
 * @param key 真实 API Key
 * @returns 脱敏串（空 key 返回空串）
 */
function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return MASK;
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

/**
 * 大模型配置存储
 *
 * 依赖注入 vscode.SecretStorage（由 extension context.secrets 提供），
 * 便于独立测试。本身不持有 LLM 状态，仅负责读写。
 */
export class ProviderStore {
  /**
   * @param secrets VS Code SecretStorage（apiKey 加密存储）
   */
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * 从 configuration 读取 Provider 列表（不含 apiKey）
   *
   * @returns 未脱敏的 Provider 列表（apiKey 字段为空占位）
   */
  private readConfig(): LlmProviderConfig[] {
    const providers = vscode.workspace
      .getConfiguration(CFG_SECTION)
      .get<Omit<LlmProviderConfig, 'apiKey'>[]>(CFG_PROVIDERS, []);
    return providers.map((p) => ({ ...p, apiKey: '' }));
  }

  /**
   * 将 Provider 列表（不含 apiKey）写入 configuration
   *
   * @param providers 待持久化的 Provider 列表
   */
  private async writeConfig(providers: LlmProviderConfig[]): Promise<void> {
    const stripped = providers.map(({ apiKey: _apiKey, ...rest }) => rest);
    await vscode.workspace
      .getConfiguration(CFG_SECTION)
      .update(CFG_PROVIDERS, stripped, vscode.ConfigurationTarget.Workspace);
  }

  /** SecretStorage 的 apiKey key */
  private secretKey(name: string): string {
    return `${SECRET_PREFIX}.${name}.apiKey`;
  }

  /**
   * 读取单个 Provider 的真实 apiKey（SecretStorage）
   *
   * @param name Provider 别名
   * @returns 真实 apiKey（未配置时为空字符串）
   */
  private async readApiKey(name: string): Promise<string> {
    return (await this.secrets.get(this.secretKey(name))) ?? '';
  }

  /**
   * 列出全部 Provider（含真实 apiKey）
   *
   * @returns 完整 Provider 列表（apiKey 为真实值，供运行/编辑使用）
   */
  async list(): Promise<LlmProviderConfig[]> {
    const configs = this.readConfig();
    const withKeys = await Promise.all(
      configs.map(async (p) => ({ ...p, apiKey: await this.readApiKey(p.name) })),
    );
    return withKeys;
  }

  /**
   * 列出全部 Provider（apiKey 脱敏，供 webview 展示）
   *
   * 填充 maskedKey 供编辑表单回显（如 `sk-••••1234`），apiKey 字段恒为空。
   *
   * @returns 脱敏 Provider 列表（apiKey 为空，maskedKey 为脱敏串）
   */
  async listMasked(): Promise<LlmProviderConfig[]> {
    const configs = this.readConfig();
    // 逐个读取真实 key 生成脱敏串（不把真实值带出 store）
    const withMasked = await Promise.all(
      configs.map(async (p) => ({ ...p, apiKey: '', maskedKey: maskKey(await this.readApiKey(p.name)) })),
    );
    return withMasked;
  }

  /**
   * 获取当前激活 Provider 的 name
   *
   * @returns 激活的 name（未设置时 undefined）
   */
  getActiveName(): string | undefined {
    return vscode.workspace.getConfiguration(CFG_SECTION).get<string>(CFG_ACTIVE);
  }

  /**
   * 获取当前激活的 Provider（含真实 apiKey）
   *
   * @returns 激活的完整 Provider 配置（无激活或不存在时 undefined）
   */
  async getActive(): Promise<LlmProviderConfig | undefined> {
    const name = this.getActiveName();
    if (!name) return undefined;
    const all = await this.list();
    return all.find((p) => p.name === name);
  }

  /**
   * 保存（新增/编辑）一个 Provider
   *
   * 新增：name 需唯一，apiKey 必填（网络模式）。
   * 编辑：name 不可变；apiKey 留空 = 保留原值；apiKey 填新值 = 覆盖。
   *
   * @param config 待保存的 Provider 配置
   * @param isEditing 是否编辑现有 Provider
   * @returns 成功返回 {ok:true}；校验/重复失败返回 {ok:false, message}
   */
  async save(config: LlmProviderConfig, isEditing: boolean): Promise<{ ok: boolean; message?: string }> {
    const trimmed = { ...config, name: config.name.trim(), model: config.model.trim(), baseUrl: config.baseUrl.trim() };

    // 新增模式：apiKey 必填
    if (!isEditing && !trimmed.apiKey.trim()) {
      return { ok: false, message: '请填写 API Key' };
    }

    const providers = this.readConfig();

    // 新增模式：检查 name 重复
    if (!isEditing && providers.some((p) => p.name === trimmed.name)) {
      return { ok: false, message: `别名 "${trimmed.name}" 已存在，请更换` };
    }

    // 编辑模式：替换（保留原有 apiKey 除非用户输入新值），否则追加
    let next: LlmProviderConfig[];
    if (isEditing) {
      next = providers.map((p) =>
        p.name === trimmed.name
          ? { ...trimmed, displayName: trimmed.displayName || trimmed.name }
          : p,
      );
    } else {
      next = [...providers, { ...trimmed, displayName: trimmed.displayName || trimmed.name }];
    }

    await this.writeConfig(next);

    // 写 apiKey：编辑且留空 → 保留原值（不覆盖）；否则写入新值
    if (!(isEditing && !trimmed.apiKey.trim())) {
      await this.secrets.store(this.secretKey(trimmed.name), trimmed.apiKey.trim());
    }
    return { ok: true };
  }

  /**
   * 删除一个 Provider（同时清理其 apiKey 与激活状态）
   *
   * @param name 待删除的 Provider 别名
   * @returns 成功返回 {ok:true}；激活中禁止删除返回 {ok:false, message}
   */
  async remove(name: string): Promise<{ ok: boolean; message?: string }> {
    if (this.getActiveName() === name) {
      return { ok: false, message: '不能删除当前激活的服务商，请先切换到其他服务商' };
    }
    const providers = this.readConfig().filter((p) => p.name !== name);
    await this.writeConfig(providers);
    await this.secrets.delete(this.secretKey(name));
    return { ok: true };
  }

  /**
   * 设为当前激活 Provider
   *
   * @param name 要激活的 Provider 别名
   * @returns 成功返回 {ok:true}；不存在返回 {ok:false, message}
   */
  async setActive(name: string): Promise<{ ok: boolean; message?: string }> {
    const exists = this.readConfig().some((p) => p.name === name);
    if (!exists) return { ok: false, message: `服务商 "${name}" 不存在` };
    await vscode.workspace
      .getConfiguration(CFG_SECTION)
      .update(CFG_ACTIVE, name, vscode.ConfigurationTarget.Workspace);
    return { ok: true };
  }

  /**
   * 清空当前激活 Provider（回滚到「无激活」状态）
   *
   * 用于 handleSetProvider 热切换失败时，若原本无激活 Provider（靠 env 装配），
   * 需把持久化激活态一并清空，否则 UI 显示新 provider 已激活但 agent 仍用 env，
   * 造成功能↔UI 不一致（对抗评估 P1-3）。
   */
  async clearActive(): Promise<void> {
    await vscode.workspace
      .getConfiguration(CFG_SECTION)
      .update(CFG_ACTIVE, undefined, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * 测试 Provider 连接（复用内核 createProviderFromConfig + chat）
   *
   * @param config 待测试的 Provider 配置（直接来自 webview 表单）
   * @returns 成功返回 {ok:true}；失败返回 {ok:false, message}
   */
  async test(config: LlmProviderConfig): Promise<{ ok: boolean; message?: string }> {
    if (!config.model.trim() || !config.apiKey.trim()) {
      return { ok: false, message: '请先填写模型和 API Key' };
    }
    try {
      // 复用内核工厂创建 OpenAI 兼容 Provider
      const provider = createProviderFromConfig(config.name, {
        baseUrl: config.baseUrl || '',
        model: config.model.trim(),
        apiKey: config.apiKey.trim(),
        provider: config.provider,
      });
      // 发起一次最小对话，验证连通性
      let reply = '';
      for await (const chunk of provider.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8 })) {
        reply += chunk.content;
        if (reply.length > 0) break;
      }
      return { ok: true, message: reply ? '连接成功' : '连接成功（无返回内容）' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}