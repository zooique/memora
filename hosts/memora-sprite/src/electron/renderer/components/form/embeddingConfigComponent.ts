/**
 * EmbeddingConfigComponent - 设置面板 Embedding 配置子组件
 *
 * 封装 Embedding 相关的 DOM 元素引用和表单读写逻辑，
 * 降低 SettingsPanelManager 的字段数量与职责复杂度。
 *
 * 设计原则：
 * - 构造函数只做 DOM 查询，不做副作用
 * - 提供 getValidationFields() 供 Manager 统一校验
 * - 不持有状态，所有数据通过方法参数传递
 *
 * 属 AUDIT-H5 SettingsPanelManager 职责拆分产物。
 */

import { getOptionalElement } from '../../helpers/domHelpers.js';

/** Embedding 配置数据结构（与 loadEmbeddingConfig 参数一致） */
export interface EmbeddingConfigData {
  embedding: { model: string; baseUrl: string; apiKey: string } | null;
}

export class EmbeddingConfigComponent {
  // ─── DOM 元素引用 ──────────────────────────────────────
  private cfgEmbEnabled: HTMLInputElement | null;
  private cfgEmbModel: HTMLInputElement | null;
  private cfgEmbBaseUrl: HTMLInputElement | null;
  private cfgEmbApiKey: HTMLInputElement | null;

  constructor() {
    this.cfgEmbEnabled = getOptionalElement('cfg-emb-enabled', 'input');
    this.cfgEmbModel = getOptionalElement('cfg-emb-model', 'input');
    this.cfgEmbBaseUrl = getOptionalElement('cfg-emb-base-url', 'input');
    this.cfgEmbApiKey = getOptionalElement('cfg-emb-api-key', 'input');
  }

  /**
   * 加载 Embedding 配置到表单
   *
   * 从主进程返回的 LLM 配置数据中提取 Embedding 部分，填充到表单字段。
   * Provider 配置由 providerManagement helper 独立管理，此方法仅处理 Embedding。
   *
   * @param data Embedding 配置数据
   */
  loadEmbeddingConfig(data: EmbeddingConfigData): void {
    if (data.embedding) {
      if (this.cfgEmbEnabled) this.cfgEmbEnabled.checked = true;
      if (this.cfgEmbModel) this.cfgEmbModel.value = data.embedding.model;
      if (this.cfgEmbBaseUrl) this.cfgEmbBaseUrl.value = data.embedding.baseUrl;
      if (this.cfgEmbApiKey) this.cfgEmbApiKey.value = data.embedding.apiKey;
    } else {
      if (this.cfgEmbEnabled) this.cfgEmbEnabled.checked = false;
    }
  }

  /**
   * 获取校验字段映射列表
   *
   * 供 Manager 统一校验所有 DOM 元素是否存在，避免 HTML ID 拼写错误导致静默失效。
   * 格式：[字段名, 元素引用, 期望 ID]
   */
  getValidationFields(): Array<[string, HTMLElement | null, string]> {
    return [
      ['cfgEmbEnabled', this.cfgEmbEnabled, 'cfg-emb-enabled'],
      ['cfgEmbModel', this.cfgEmbModel, 'cfg-emb-model'],
      ['cfgEmbBaseUrl', this.cfgEmbBaseUrl, 'cfg-emb-base-url'],
      ['cfgEmbApiKey', this.cfgEmbApiKey, 'cfg-emb-api-key'],
    ];
  }
}