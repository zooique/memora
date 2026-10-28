/**
 * 大模型 Provider 存储层 — 多 Provider 配置的持久化与连接测试
 *
 * 职责：
 *   - 非敏感字段（name/displayName/model/baseUrl/provider）存 VS Code configuration
 *     （写入【用户级】settings.json 的 memora.providers；Provider 是用户级偏好，非项目级，
 *     不落 .vscode/settings.json 且跨项目共享）
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
// 配置写入唯一通道（5s 超时兜底：只读/受管设置上 update 可能永不 settle）
import { writeErrorText, writeSetting, type WriteResult } from '../settingsWrite.js';
// 密钥访问唯一通道（与配置通道对称：钥匙串不可用时 store/delete/get 会 reject，
// 裸调会把半完成态当异常抛出、把读取失败升级成面板空列表，回执与磁盘事实脱节）
import {
  deleteSecret,
  readSecret,
  secretErrorText,
  secretMissingText,
  writeSecret,
  type ReadResult,
} from '../host/secretsAccess.js';
import type { LlmProviderConfig } from '../../shared/protocol.js';

/** configuration 段名（memora.providers） */
export const CFG_SECTION = 'memora';
/** providers 数组配置键 */
export const CFG_PROVIDERS = 'providers';
/** activeProvider 配置键 */
const CFG_ACTIVE = 'activeProvider';
/** backgroundProvider 配置键（后台模型通道：空 = 与实时对话相同） */
const CFG_BACKGROUND = 'backgroundProvider';
/** SecretStorage apiKey key 前缀 */
const SECRET_PREFIX = 'memora.provider';

/**
 * Provider apiKey 的 SecretStorage key（**单一构造点**，SSOT）
 *
 * 由「初始化」清空（userDataReset）与 ProviderStore 读写共用：清空侧必须按同一
 * 构造式枚举待删 secret，禁拼第二份字面量（改了前缀一处同步、两处必漂移）。
 *
 * @param name Provider 别名
 */
export function providerSecretKey(name: string): string {
  return `${SECRET_PREFIX}.${name}.apiKey`;
}

/** 脱敏占位符（apiKey 为空或已配置时展示） */
const MASK = '••••••••';
/** contextWindow 合法下限（token）：低于此无意义（防 0 / 极小值撑不起任何对话） */
const CONTEXT_WINDOW_MIN = 1024;
/** contextWindow 合法上限（token）：防天文数字撑爆预算分配 */
const CONTEXT_WINDOW_MAX = 10_000_000;
/** maxTokens 合法下限（token）：正整数底线（0 / 负数无 token 语义） */
const MAX_TOKENS_MIN = 1;
/** maxTokens 合法上限（token）：独立 sanity（覆盖现有模型 max_tokens 能力上限），非与内核对齐的裁决线——
 *  真实上限由模型/API 决定，超限由服务端可见报错（内核上限不裁决，见 openaiCompatible.normalizeMaxTokens） */
const MAX_TOKENS_MAX = 65_536;

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
   * 经统一写入通道（带超时上限）：返回结果而不是抛错——
   * 调用方 save / remove 要把失败转成 `{ok:false, message}` 回执（cfg_result），
   * 迁移逻辑则据此中止后续步骤（不删源数据）。
   *
   * @param providers 待持久化的 Provider 列表
   * @returns 写入结果（失败含超时 / reject 原因）
   */
  private async writeConfig(providers: LlmProviderConfig[]): Promise<WriteResult> {
    const stripped = providers.map(({ apiKey: _apiKey, ...rest }) => rest);
    return writeSetting(CFG_PROVIDERS, stripped);
  }

  /**
   * 读取单个 Provider 的真实 apiKey（SecretStorage，经唯一访问通道）
   *
   * @param name Provider 别名
   * @returns 读取结果：ok=true 时 value 为真实 key（未存过 = undefined）；
   *   ok=false = 钥匙串读取失败（永不 reject，调用方判 ok 留痕/抛出，禁降级空值）
   */
  private async readApiKey(name: string): Promise<ReadResult> {
    return readSecret(this.secrets, providerSecretKey(name));
  }

  /**
   * 单条 key 读取失败的文案（list / listMasked / 运行面共用的唯一派生点）
   *
   * 此前 list 与 listMasked 各写一份同款 `secretErrorText(...)` 调用——两处模板
   * 漂移会让同一故障在面板与运行路径显示不同原因（判据散点）。收口成私有单点，
   * 与 secretsAccess 的 secretErrorText / secretMissingText 组成三层派生链。
   */
  private keyReadError(name: string, r: { timedOut: boolean; reason: string }): string {
    return secretErrorText(`API Key「${name}」读取`, r);
  }

  /**
   * 读取单条 Provider（含真实 apiKey）——list 与运行面共用的 per-item 通道
   *
   * 读失败**逐条留 keyError**（不抛）：展示面（listMasked）要靠它把完整列表
   * 渲染出来；运行面（readRuntimeEntry）再决定抛不抛。
   *
   * @param p 不含 apiKey 的 Provider 配置（readConfig 的产物）
   * @returns 完整 config（apiKey 为真实值；keyError 非空 = 该条 key 读取失败）
   */
  private async readOne(p: Omit<LlmProviderConfig, 'apiKey'>): Promise<LlmProviderConfig> {
    const r = await this.readApiKey(p.name);
    if (r.ok) return { ...p, apiKey: r.value ?? '' };
    return { ...p, apiKey: '', keyError: this.keyReadError(p.name, r) };
  }

  /**
   * 列出全部 Provider（含真实 apiKey）
   *
   * 逐个读取 key 并**逐条捕获失败**（禁 Promise.all 一 reject 全 throw）：
   * 某个 Provider 的 key 读失败只在该条上留 `keyError` 痕迹，不影响其他条目——
   * 否则一个坏 key 会拖垮整个运行路径（含活跃 Provider 完好的场景）。
   *
   * @returns 完整 Provider 列表（apiKey 为真实值；keyError 非空 = 该条 key 读取失败）
   */
  async list(): Promise<LlmProviderConfig[]> {
    const configs = this.readConfig();
    return Promise.all(configs.map((p) => this.readOne(p)));
  }

  /**
   * 列出全部 Provider（apiKey 脱敏，供 webview 展示）
   *
   * 填充 maskedKey 供编辑表单回显（如 `sk-••••1234`），apiKey 字段恒为空。
   * key 读取失败同样逐条留痕（`keyError`）：面板必须打开、列表必须完整——
   * 静默显示空列表 = 让用户以为「没配过服务商」（谎报）；降级成空 maskedKey
   * = 让用户以为「没存 key」（也是谎报）。两条都禁，只留「这条 key 状态未知」的痕迹。
   *
   * @returns 脱敏 Provider 列表（apiKey 为空，maskedKey 为脱敏串；keyError 非空 = 读取失败）
   */
  async listMasked(): Promise<LlmProviderConfig[]> {
    const configs = this.readConfig();
    // 逐个读取真实 key 生成脱敏串（不把真实值带出 store）
    return Promise.all(
      configs.map(async (p) => {
        const r = await this.readApiKey(p.name);
        if (r.ok) return { ...p, apiKey: '', maskedKey: maskKey(r.value ?? '') };
        return { ...p, apiKey: '', keyError: this.keyReadError(p.name, r) };
      }),
    );
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
   * 读取运行面目标条（getActive / getBackground 共用的唯一通道）
   *
   * 与 list 的关键差异：**只读目标条一个 key**。此前两方法走 `list()` 读全部
   * Provider 的 key——激活/后台名已知，其余 N-1 个 key 的触达纯属浪费，且
   * 扩大 SecretStorage 暴露面（不需要的秘密不读，与 SEC 族一贯立场一致）。
   * 跨 Provider 污染（H3）由「只读目标条」结构性保证，不再依赖 list 的
   * 逐条留痕事后过滤。
   *
   * 三条拒绝路径（顺序即优先级，测试逐条钉死）：
   *   1. 目标 name 不在配置中 ⇒ undefined（无激活/悬空引用的既有语义，不抛）；
   *   2. 该条 key 读取失败（keyError）⇒ 抛语义标签错误——状态未知比没有 key
   *      更严重，先报「读取 失败」；
   *   3. 读成功但从未存过（apiKey === ''）⇒ 抛「未存储」（SEC-READ-2 第三态）：
   *      在册服务商本应有 key，空即异常来路（半完成态残留 / userDataReset
   *      中间态 / 设置同步不含密钥 / 凭证被清理）。空 key 打到服务端只会报一个
   *      与真实原因无关的 401——那是「用错原因解释失败」。
   *
   * @param name 目标 Provider 别名（调用方已确认非空）
   * @returns 目标条完整 config；不存在时 undefined
   */
  private async readRuntimeEntry(name: string): Promise<LlmProviderConfig | undefined> {
    const target = this.readConfig().find((p) => p.name === name);
    if (!target) return undefined;
    const entry = await this.readOne(target);
    if (entry.keyError) throw new Error(entry.keyError);
    if (!entry.apiKey) {
      throw new Error(secretMissingText(`API Key「${name}」`));
    }
    return entry;
  }

  /**
   * 获取当前激活的 Provider（含真实 apiKey）
   *
   * 只读激活条一个 key（readRuntimeEntry）：非激活 Provider 的坏 key 影响不了
   * 本路径。三条拒绝路径与文案见 {@link readRuntimeEntry}；无激活 Provider
   * 时返回 undefined（环境变量装配场景，chatPanel 据此回落 env 分支）。
   *
   * @returns 激活的完整 Provider 配置（无激活或不存在时 undefined）
   */
  async getActive(): Promise<LlmProviderConfig | undefined> {
    const name = this.getActiveName();
    if (!name) return undefined;
    return this.readRuntimeEntry(name);
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
  async save(
    config: LlmProviderConfig,
    isEditing: boolean,
  ): Promise<{ ok: boolean; message?: string }> {
    const trimmed = {
      ...config,
      name: config.name.trim(),
      model: config.model.trim(),
      baseUrl: config.baseUrl.trim(),
    };

    // contextWindow 护栏（**纯防呆 sanity bound**，非模型真上限、也非权威裁决）：正整数 + 宽松范围，
    // 防 0 / 防天文数字撑爆预算。
    // ⚠️ 内核侧**不做区间裁决**：若内核对超范围值静默丢弃，会「UI 显示值 ≠ 真实生效值」（坑）。
    // 故本护栏是**唯一**的输入边界，但它只防手滑 —— 真实上限由模型/API 决定，
    // 超出模型能力时由 API 报错（可见），不被任何一层静默替换。
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

    // maxTokens 护栏（**独立 sanity bound**，与 contextWindow 同哲学）：正整数 + 区间校验。
    // 宿主先拒收（可见报错），防「UI 显示值 ≠ 真实生效值」（坑）：内核请求层只对非正整数
    // 静默忽略（形态防御），上限不裁决——超限值原样透传、由服务端可见报错。故本护栏是
    // 输入边界的唯一可见裁决点，但它只防手滑；真实上限由模型/API 决定。
    if (trimmed.maxTokens !== undefined) {
      if (
        !Number.isInteger(trimmed.maxTokens) ||
        trimmed.maxTokens < MAX_TOKENS_MIN ||
        trimmed.maxTokens > MAX_TOKENS_MAX
      ) {
        return {
          ok: false,
          message: `输出上限需为 ${MAX_TOKENS_MIN}–${MAX_TOKENS_MAX} 之间的整数 token`,
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

    // 写入失败（含只读/受管设置的「永不 settle」超时）⇒ 不写 apiKey、返回回执：
    // 配置没落盘却把 key 存进 SecretStorage，会让「UI 有服务商、重启后消失」且留下孤儿密钥
    const written = await this.writeConfig(next);
    if (!written.ok) return { ok: false, message: writeErrorText('服务商配置', written) };

    // 写 apiKey：编辑且留空 → 保留原值（不覆盖）；否则写入新值。
    // 经密钥写入唯一通道：钥匙串不可用时返回失败而不是裸抛——
    // 此刻配置已落盘（服务商会出现在列表里）而密钥没存上 = 半完成态，
    // 回执必须如实说明「配置已保存、密钥未保存」，不自动回滚配置
    // （回滚自身也可能失败，且用户填的字段是资产），用户保留表单内容可改可重试。
    if (!(isEditing && !trimmed.apiKey.trim())) {
      const stored = await writeSecret(
        this.secrets,
        providerSecretKey(trimmed.name),
        trimmed.apiKey.trim(),
      );
      if (!stored.ok) {
        return {
          ok: false,
          message:
            `服务商配置已保存，但 ${secretErrorText('API Key', stored)}。` +
            `该服务商暂时无法使用；请关闭表单，在服务商列表中编辑它补填 API Key。`,
        };
      }
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
    // 配置没删掉就不能删 apiKey：否则配置里还留着服务商、密钥却没了（下次激活必然失败）
    const written = await this.writeConfig(providers);
    if (!written.ok) return { ok: false, message: writeErrorText('服务商配置', written) };
    // 密钥删除同走唯一通道：此刻配置已删（服务商从列表消失）而密钥没删掉 = 孤儿密钥，
    // 回执必须点出后果——同名服务商重新添加后「编辑留空」会读到旧密钥（静默用错 key），
    // 并给出出路（重启重试 / 系统凭证管理器手动删）。不谎报 ok:true。
    const deleted = await deleteSecret(this.secrets, providerSecretKey(name));
    if (!deleted.ok) {
      return {
        ok: false,
        message:
          `服务商已从配置中删除，但 ${secretErrorText('API Key 清理', deleted)}。` +
          `旧密钥仍留在系统钥匙串中，重新添加同名服务商可能沿用旧密钥；` +
          `请重启 VS Code 后重试，或在系统凭证管理器中手动删除。`,
      };
    }
    // 删除的若是后台模型 Provider，清除后台通道引用（避免悬空指向不存在的 name）
    if (name === this.getBackgroundName()) {
      const cleared = await this.setBackground('');
      // 删除本身已生效（配置 + 密钥都清了）⇒ 清引用失败不反向否决结果，但必须留痕：
      // 后台通道会悬空指向不存在的 name（读取侧回落前台，功能不坏，但配置里是脏数据）
      if (!cleared.ok) console.warn(`Memora 后台模型引用清理失败：${cleared.message}`);
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
    // 激活态也是用户级配置：经统一写入通道（带 5s 上限），失败回执而不是挂死
    const written = await writeSetting(CFG_ACTIVE, name);
    if (!written.ok) return { ok: false, message: writeErrorText('服务商激活状态', written) };
    return { ok: true };
  }

  /**
   * 清空当前激活 Provider（回滚到「无激活」状态）
   *
   * 用于 handleSetProvider 热切换失败时，若原本无激活 Provider（靠 env 装配），
   * 需把持久化激活态一并清空，否则 UI 显示新 provider 已激活但 agent 仍用 env，
   * 造成功能↔UI 不一致。
   *
   * @returns 成功 {ok:true}；写失败 {ok:false, message}（回滚路径据此并入错误回执，不静默）
   */
  async clearActive(): Promise<{ ok: boolean; message?: string }> {
    const written = await writeSetting(CFG_ACTIVE, undefined);
    if (!written.ok) return { ok: false, message: writeErrorText('服务商激活状态', written) };
    return { ok: true };
  }

  /**
   * 读取后台模型 Provider 的 name（多 Provider 路由）
   *
   * 空（undefined）= 后台任务与实时对话使用同一 Provider（未独立配置后台通道）。
   *
   * @returns 后台 Provider 的 name；未配置返回 undefined
   */
  getBackgroundName(): string | undefined {
    return vscode.workspace.getConfiguration(CFG_SECTION).get<string>(CFG_BACKGROUND);
  }

  /**
   * 设置后台模型 Provider 的 name（多 Provider 路由）
   *
   * name 为空字符串表示「清除后台独立配置」，后台任务回退到与实时对话相同 Provider。
   * 经统一写入通道（带 5s 上限）：写失败回执，调用方据此**不**做热切换（避免切到未落盘的配置）。
   *
   * @param name 后台 Provider 别名（空串清除）
   * @returns 成功 {ok:true}；写失败 {ok:false, message}
   */
  async setBackground(name: string): Promise<{ ok: boolean; message?: string }> {
    const written = await writeSetting(CFG_BACKGROUND, name || undefined);
    if (!written.ok) return { ok: false, message: writeErrorText('后台模型设置', written) };
    return { ok: true };
  }

  /**
   * 获取后台 Provider 的完整配置（含真实 apiKey）
   *
   * 未配置后台通道（getBackgroundName 为空）或该 name 不存在时返回 undefined。
   * 与 getActive 共用 {@link readRuntimeEntry}：只读后台条一个 key，
   * 读失败抛语义标签错误（不静默回落前台——静默回落 = 后台任务悄悄用了
   * 另一个模型，用户不可见的降级），第三态（SEC-READ-2）同样抛「未存储」。
   *
   * @returns 后台 Provider config；无独立后台配置返回 undefined
   */
  async getBackground(): Promise<LlmProviderConfig | undefined> {
    const name = this.getBackgroundName();
    if (!name) return undefined;
    return this.readRuntimeEntry(name);
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
        // 能力位透传（互斥双能力位）：未声明由内核按**各自方向**回落——
        // supportsToolCalling → true；supportsStructuredOutput → false（勿读成「默认都开」）。
        supportsToolCalling: config.supportsToolCalling,
        supportsStructuredOutput: config.supportsStructuredOutput,
        //
        // ⚠️ 此处刻意不透传 supportsVision：test() 只做连通性探测（ping 一次「通不通」），
        // 不解析 capabilities 响应，也拿不到任何「该模型是否真支持视觉」的证据。
        // 透传一个永不被读取的字段 = 死接线，且会让「测试通过」被误读成「视觉也可用」。
        // 能力位进入内核的**唯一真实通路**是 host/llmConfig.ts（前台 + 后台两处构造）。
      });
      // 发起一次最小对话，验证连通性
      let reply = '';
      for await (const chunk of provider.chat([{ role: 'user', content: 'ping' }], {
        maxTokens: 8,
      })) {
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
   * 一次性迁移：工作区 settings.json 旧残留 → 用户级
   *
   * 背景：Provider 配置现写入 Global（用户级），若工作区仍残留旧配置，VS Code 配置合并时 Workspace 优先级高于 Global，会覆盖新值
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
    // 写失败即中止：工作区残留必须先并入 Global 再清，否则清完就真丢了（用户配置无副本可恢复）
    if (merged.length !== globalProviders.length) {
      const written = await writeSetting(CFG_PROVIDERS, merged);
      if (!written.ok) {
        console.warn(`Memora 旧 Provider 配置迁移中止：${writeErrorText('服务商配置', written)}`);
        return;
      }
    }
    if (wsActive !== undefined && activeInspect?.globalValue === undefined) {
      const written = await writeSetting(CFG_ACTIVE, wsActive);
      if (!written.ok) {
        console.warn(
          `Memora 旧 Provider 激活态迁移中止：${writeErrorText('服务商激活状态', written)}`,
        );
        return;
      }
    }
    // 清除工作区级残留（避免覆盖 Global 新配置）
    const clearedProviders = await writeSetting(
      CFG_PROVIDERS,
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
    const clearedActive = await writeSetting(
      CFG_ACTIVE,
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
    if (!clearedProviders.ok || !clearedActive.ok) {
      console.warn('Memora 工作区级旧 Provider 配置清理未完成：设置文件可能只读或被占用');
    }
  }

  /**
   * 一次性迁移：旧全局 memora.maxContextTokens → per-LLM contextWindow（窗口模型）
   *
   * 背景：memora.maxContextTokens 是用户级全局设置（单一值作用于所有 LLM）的旧键；
   * 现真理源为 per-LLM 配置（LlmProviderConfig.contextWindow），全局键不是真理源。
   * 为不丢用户已填值：激活时把旧全局值并入首个尚未配置 contextWindow 的 Provider；
   * 随后清除旧全局键（消除双真理源残留）。无旧值 / 无 Provider 时 → 无动作。
   *
   * 生命周期：内建守卫让函数幂等空转（旧键清空后每次 early-return），
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
        const written = await this.writeConfig(providers);
        // 新值没落盘就绝不能删旧键：否则用户已填的窗口配置凭空消失（无副本可恢复）
        if (!written.ok) {
          console.warn(
            `Memora 旧 maxContextTokens 迁移中止：${writeErrorText('服务商配置', written)}`,
          );
          return;
        }
      }
    }
    // 清除旧全局设置（不作真理源，避免与 per-LLM contextWindow 双源）
    const cleared = await writeSetting('maxContextTokens', undefined);
    if (!cleared.ok) {
      console.warn(`Memora 旧 maxContextTokens 清理未完成：${writeErrorText('旧设置', cleared)}`);
    }
  }
}
