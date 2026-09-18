/**
 * 大模型 Provider 存储层 — 多 Provider 配置的持久化与连接测试
 *
 * 职责：
 *   - 非敏感字段（name/displayName/model/baseUrl/provider）存 VS Code configuration
 *     （写入【用户级】settings.json 的 memora.providers；Provider 是用户级偏好，非项目级，
 *     2026-08-17 由 Workspace 迁至 Global——避免污染 .vscode/settings.json 且跨项目共享）
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
/** backgroundProvider 配置键（G5 后台模型通道，2026-08-23：空 = 与实时对话相同） */
const CFG_BACKGROUND = 'backgroundProvider';
/** embedding 配置键（G1 向量检索，2026-08-23：非敏感字段 model/baseUrl） */
const CFG_EMBEDDING = 'embedding';
/** embedding apiKey 的 SecretStorage key */
const EMBEDDING_SECRET = 'memora.embedding.apiKey';
/** SecretStorage apiKey key 前缀 */
const SECRET_PREFIX = 'memora.provider';

/** 脱敏占位符（apiKey 为空或已配置时展示） */
const MASK = '••••••••';
/** contextWindow 合法下限（token）：低于此无意义（防 0 / 极小值撑不起任何对话） */
const CONTEXT_WINDOW_MIN = 1024;
/** contextWindow 合法上限（token）：防天文数字撑爆预算分配 */
const CONTEXT_WINDOW_MAX = 10_000_000;

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
      .update(CFG_PROVIDERS, stripped, vscode.ConfigurationTarget.Global);
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

    // contextWindow 护栏（**纯防呆 sanity bound**，非模型真上限、也非权威裁决）：正整数 + 宽松范围，
    // 防 0 / 防天文数字撑爆预算。
    // ⚠️ 内核侧**不做区间裁决**（2026-09-18 拍板）：此前内核对 >2M 静默丢弃，导致「UI 显示值 ≠ 真实生效值」，
    // 该裁决已删除。故本护栏是**唯一**的输入边界，但它只防手滑 —— 真实上限由模型/API 决定，
    // 超出模型能力时由 API 报错（可见），不再被任何一层静默替换。
    if (trimmed.contextWindow !== undefined) {
      if (
        !Number.isInteger(trimmed.contextWindow) ||
        trimmed.contextWindow < CONTEXT_WINDOW_MIN ||
        trimmed.contextWindow > CONTEXT_WINDOW_MAX
      ) {
        return {
          ok: false,
          message: `上下文上限需为 ${CONTEXT_WINDOW_MIN}–${CONTEXT_WINDOW_MAX} 之间的整数 token`,
        };
      }
    }

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
    // 删除的若是后台模型 Provider，清除后台通道引用（避免悬空指向不存在的 name）
    if (name === this.getBackgroundName()) {
      await this.setBackground('');
    }
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
      .update(CFG_ACTIVE, name, vscode.ConfigurationTarget.Global);
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
      .update(CFG_ACTIVE, undefined, vscode.ConfigurationTarget.Global);
  }

  /**
   * 读取后台模型 Provider 的 name（G5 多 Provider 路由）
   *
   * 空（undefined）= 后台任务与实时对话使用同一 Provider（未独立配置后台通道）。
   *
   * @returns 后台 Provider 的 name；未配置返回 undefined
   */
  getBackgroundName(): string | undefined {
    return vscode.workspace.getConfiguration(CFG_SECTION).get<string>(CFG_BACKGROUND);
  }

  /**
   * 设置后台模型 Provider 的 name（G5 多 Provider 路由）
   *
   * name 为空字符串表示「清除后台独立配置」，后台任务回退到与实时对话相同 Provider。
   *
   * @param name 后台 Provider 别名（空串清除）
   */
  async setBackground(name: string): Promise<void> {
    await vscode.workspace
      .getConfiguration(CFG_SECTION)
      .update(CFG_BACKGROUND, name || undefined, vscode.ConfigurationTarget.Global);
  }

  /**
   * 获取后台 Provider 的完整配置（含真实 apiKey；G5）
   *
   * 未配置后台通道（getBackgroundName 为空）或该 name 不存在时返回 undefined。
   *
   * @returns 后台 Provider config；无独立后台配置返回 undefined
   */
  async getBackground(): Promise<LlmProviderConfig | undefined> {
    const name = this.getBackgroundName();
    if (!name) return undefined;
    const all = await this.list();
    return all.find((p) => p.name === name);
  }

  /**
   * 读取向量检索（Embedding）配置（G1 记忆语义检索）
   *
   * enabled = 已配置 model 且 baseUrl 非空；apiKey 不在此暴露真实值（由 getEmbeddingSecret 读取）。
   *
   * @returns embedding 配置（若未配置 enabled=false）
   */
  async getEmbeddingConfig(): Promise<{ enabled: boolean; model?: string; baseUrl?: string }> {
    const cfg = vscode.workspace.getConfiguration(CFG_SECTION).get<{ model?: string; baseUrl?: string }>(CFG_EMBEDDING);
    const model = cfg?.model?.trim();
    const baseUrl = cfg?.baseUrl?.trim();
    return { enabled: Boolean(model && baseUrl), model, baseUrl };
  }

  /** 读取 embedding apiKey（真实值，供创建 EmbeddingProvider） */
  async getEmbeddingSecret(): Promise<string> {
    return (await this.secrets.get(EMBEDDING_SECRET)) ?? '';
  }

  /**
   * 保存向量检索（Embedding）配置（G1）
   *
   * model/baseUrl 写 configuration（Global）；apiKey 留空 = 保留原值（对齐 Provider 编辑语义）。
   *
   * @param input embedding 配置（model/baseUrl 必填；apiKey 可空=保留）
   * @returns 成功返回 {ok:true}；校验失败返回 {ok:false,message}
   */
  async saveEmbedding(input: { model: string; baseUrl: string; apiKey: string }): Promise<{ ok: boolean; message?: string }> {
    const model = input.model.trim();
    const baseUrl = input.baseUrl.trim();
    if (!model || !baseUrl) {
      return { ok: false, message: '请填写 Embedding 模型与 Base URL' };
    }
    await vscode.workspace
      .getConfiguration(CFG_SECTION)
      .update(CFG_EMBEDDING, { model, baseUrl }, vscode.ConfigurationTarget.Global);
    // apiKey 非空才写（空 = 保留原值）
    if (input.apiKey.trim()) {
      await this.secrets.store(EMBEDDING_SECRET, input.apiKey.trim());
    }
    return { ok: true };
  }

  /**
   * 清除向量检索（Embedding）配置（G1）
   *
   * 清空非敏感字段 + SecretStorage apiKey；装配侧配置缺失即回退关键词搜索，零破坏性。
   */
  async clearEmbedding(): Promise<void> {
    await vscode.workspace
      .getConfiguration(CFG_SECTION)
      .update(CFG_EMBEDDING, undefined, vscode.ConfigurationTarget.Global);
    await this.secrets.delete(EMBEDDING_SECRET);
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
        // 能力位透传（互斥双能力位，2026-09-14 阶段0）：undefined → 内核回落 true
        supportsToolCalling: config.supportsToolCalling,
        supportsStructuredOutput: config.supportsStructuredOutput,
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

  /**
   * 一次性迁移：工作区 settings.json 旧残留 → 用户级（2026-08-17 存储层级收敛）
   *
   * 背景：Provider 配置原写入 Workspace（.vscode/settings.json），改为 Global（用户级）后，
   * 若工作区仍残留旧配置，VS Code 配置合并时 Workspace 优先级高于 Global，会覆盖新值
   * 导致用户新配置不生效。故 activate 时检测 workspaceValue 并并入 Global 后清除。
   *
   * 合并语义：按 name 去重——Global 已有则保留（用户新改的真源），Workspace 独有并入；
   * activeProvider 仅在 Global 无值时迁移。apiKey 存 SecretStorage，不受配置层级影响，无需迁移。
   */
  async migrateFromWorkspace(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
    const provInspect = cfg.inspect<Omit<LlmProviderConfig, 'apiKey'>[]>(CFG_PROVIDERS);
    const activeInspect = cfg.inspect<string | undefined>(CFG_ACTIVE);
    const wsProviders = provInspect?.workspaceValue ?? [];
    const wsActive = activeInspect?.workspaceValue;
    // 无工作区残留 → 无迁移动作
    if (wsProviders.length === 0 && wsActive === undefined) return;

    const globalProviders = provInspect?.globalValue ?? [];
    const names = new Set(globalProviders.map((p) => p.name));
    const merged = [...globalProviders, ...wsProviders.filter((p) => !names.has(p.name))];
    if (merged.length !== globalProviders.length) {
      await cfg.update(CFG_PROVIDERS, merged, vscode.ConfigurationTarget.Global);
    }
    if (wsActive !== undefined && activeInspect?.globalValue === undefined) {
      await cfg.update(CFG_ACTIVE, wsActive, vscode.ConfigurationTarget.Global);
    }
    // 清除工作区级残留（避免覆盖 Global 新配置）
    await cfg.update(CFG_PROVIDERS, undefined, vscode.ConfigurationTarget.Workspace);
    await cfg.update(CFG_ACTIVE, undefined, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * 一次性迁移：旧全局 memora.maxContextTokens → per-LLM contextWindow（2026-08-29 窗口模型收敛）
   *
   * 背景：上下文窗口上限原为用户级全局设置 memora.maxContextTokens（单一值作用于所有 LLM）。
   * 收敛为 per-LLM 配置（LlmProviderConfig.contextWindow）后，全局设置不再是真理源。
   * 为不丢用户已填值：激活时把旧全局值并入首个尚未配置 contextWindow 的 Provider；
   * 随后清除旧全局键（消除双真理源残留）。无旧值 / 无 Provider 时 → 无动作。
   *
   * 生命周期（收敛卫生项，2026-08-30 标注）：内建守卫让函数幂等空转（旧键清空后每次 early-return），
   * 长期保留零成本，故不强制移除；如需瘦身，须确认全量用户已迁移（无评估手段）后再于版本门槛内下线，
   * 下线前删除本函数 + extension.activate 调用 + providerStore.test.ts 对应用例。
   */
  async migrateMaxContextTokens(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
    const old = cfg.inspect<number | undefined>('maxContextTokens')?.globalValue;
    if (old === undefined) return;
    const providers = this.readConfig();
    if (providers.length > 0) {
      const target = providers.find((p) => p.contextWindow === undefined);
      if (target) {
        target.contextWindow = old;
        await this.writeConfig(providers);
      }
    }
    // 清除旧全局设置（不再作为真理源，避免与 per-LLM contextWindow 双源）
    await cfg.update('maxContextTokens', undefined, vscode.ConfigurationTarget.Global);
  }
}