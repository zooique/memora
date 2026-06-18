/**
 * 渲染进程入口
 *
 * 职责：
 * - 初始化 UI 管理器
 * - 监听 IPC 事件（流式输出、主动提示、精灵事件）
 * - 协调业务逻辑与 UI 操作
 * - 发送用户输入到主进程
 *
 * MVP 阶段（迭代 0-4）仅骨架实现，核心逻辑逐步填充。
 */

import type { ElectronAPI } from '../preload.js';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// ─── 错误类型定义 ─────────────────────────────────────────

interface AppError {
  code: string;
  message: string;
  timestamp: string;
}

// ─── 导入 UI 管理器 ─────────────────────────────────────

import { UIManager } from './ui.js';
import type { MemoryListItem, MemorySearchHit, MemoryDetail, SpriteConfigForm } from './ui.js';

// ─── 状态 ───────────────────────────────────────────────────

let uiManager: UIManager;

// ─── 初始化 ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // 初始化 UI 管理器
  uiManager = new UIManager();

  // 设置业务逻辑回调
  setupBusinessLogic();
  setupMemoryPanel();
  setupPersonaSelector();
  setupSettingsPanel();

  // 初始化 IPC 监听器
  initStreamListeners();
  initSpriteOutputListener();
  initSpriteEventListener();
  initProactivePromptListener();
  initAppErrorListener();
  initFloatUnreadListener();
  initAgentReadyListener();

  // 加载 LLM 配置到设置面板（无论 Agent 是否就绪都加载）
  await loadLlmConfig();

  // 检查 Agent 是否就绪
  try {
    const { ready } = await window.electronAPI.getAgentStatus();
    if (!ready) {
      // 首次启动引导：显示欢迎消息 + 自动跳转到设置面板
      uiManager.appendMessage({
        role: 'system',
        content: '🎉 欢迎使用 Memora Sprite！\n\n首次使用需要配置 LLM 提供商和 API Key。\n已为您打开设置面板，请填写 LLM 配置后点击「保存」即可开始对话。\n\n推荐使用 DeepSeek（性价比高）或 OpenAI GPT-4o-mini。',
      });
      // 自动切换到设置面板
      uiManager.switchPanel('settings');
      // 仍加载精灵配置，让用户能在设置面板中配置
      await loadConfig();
      return;
    }
  } catch {
    // agent-status 通道不存在（旧版本兼容），继续正常加载
  }

  // 加载初始数据
  await loadSessionHistory();
  void loadMemoryList();
  void loadPersonaList();
  void loadConfig();
});

// ─── 清理资源 ─────────────────────────────────────────────

// 页面卸载时清理资源
window.addEventListener('beforeunload', () => {
  uiManager?.cleanup();
});

// ─── 业务逻辑设置 ─────────────────────────────────────────

function setupBusinessLogic(): void {
  // 设置发送消息回调
  uiManager.onSendMessage(() => {
    const text = uiManager.getUserInput();
    if (!text) return;

    // 显示用户消息
    uiManager.appendMessage({
      role: 'user',
      content: text,
    });

    // 发送到主进程
    window.electronAPI.sendUserInput(text);
  });

  // 设置停止消息回调
  uiManager.onStopMessage(async () => {
    await window.electronAPI.abortChat();
    uiManager.stopAllStreaming();
  });
}

// ─── 历史消息加载 ──────────────────────────────────────────

async function loadSessionHistory(): Promise<void> {
  try {
    const { messages } = await window.electronAPI.loadSession({});
    for (const msg of messages as Array<{ role: string; content: string }>) {
      uiManager.appendMessage({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }
  } catch {
    // ignore
  }
}

// ─── 流式输出 ──────────────────────────────────────────────

function initStreamListeners(): void {
  window.electronAPI.onStreamStart((msg) => {
    uiManager.startStreaming(msg.messageId);
  });

  window.electronAPI.onStreamChunk((msg) => {
    uiManager.updateStreamingMessage(msg.messageId, msg.text);
  });

  window.electronAPI.onStreamEnd((msg) => {
    uiManager.finishStreamingMessage(msg.messageId);
  });
}

// ─── 精灵输出（主动提示 / 系统消息） ───────────────────────

function initSpriteOutputListener(): void {
  window.electronAPI.onSpriteOutput((msg) => {
    uiManager.appendMessage({
      role: 'system',
      content: msg.text,
    });

    // 通知主进程：主动提示已显示（用于清除未读计数）
    if (msg.kind === 'proactive') {
      uiManager.clearUnreadCount();
      window.electronAPI.proactivePromptShown();
    }
  });
}

// ─── 精灵事件 ──────────────────────────────────────────────

function initSpriteEventListener(): void {
  window.electronAPI.onSpriteEvent((msg) => {
    if (msg.type === 'memoryNoticed') {
      pulseCounter('memory-count');
    } else if (msg.type === 'insightGained') {
      pulseCounter('insight-count');
    }
  });
}

function pulseCounter(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(parseInt(el.textContent ?? '0') + 1);
  el.classList.add('pulse');
  setTimeout(() => el.classList.remove('pulse'), 300);
}

// ─── 主动提示（Electron 分发逻辑） ─────────────────────────

function initProactivePromptListener(): void {
  window.electronAPI.onSpriteEvent((msg) => {
    if (msg.type !== 'proactivePrompt') return;
    const { silent } = msg.payload as { prompt: string; triggers: string[]; silent: boolean };

    if (!silent) {
      // 非静默模式：通知渲染进程显示窗口内提示
      if (uiManager.getCurrentPanel() !== 'chat') {
        uiManager.switchPanel('chat');
      }
    }
    // 静默模式下：仅更新数字，不弹窗（由托盘在 ipcHandlers 层处理）
  });
}

// ─── 应用错误处理 ─────────────────────────────────────────

function initAppErrorListener(): void {
  window.electronAPI.onAppError((error: AppError) => {
    // 显示错误消息给用户
    uiManager.appendMessage({
      role: 'system',
      content: `⚠️ ${error.message}`,
    });

    console.error(`[${error.code}] ${error.message}`, error);
  });
}

// ─── 浮动窗口未读计数 ─────────────────────────────────────

function initFloatUnreadListener(): void {
  window.electronAPI.onFloatUnread((count: number) => {
    // 浮动窗口未读计数同步（完整窗口的徽章由 UIManager 内部维护）
    // 这里仅处理浮动窗口的未读计数显示逻辑
    if (count > 0) {
      uiManager.appendMessage({
        role: 'system',
        content: `精灵有 ${count} 条新消息`,
      });
    }
  });
}

// ─── 记忆面板业务逻辑 ─────────────────────────────────────

/** 设置记忆面板回调 */
function setupMemoryPanel(): void {
  // 搜索回调
  uiManager.onMemorySearch(async (query: string) => {
    if (!query) {
      // 空搜索：加载全部
      await loadMemoryList();
      return;
    }
    try {
      const { hits } = await window.electronAPI.searchMemories(query);
      const items: MemoryListItem[] = (hits as MemorySearchHit[]).map(h => ({
        id: h.name, // 搜索结果没有 id 字段，用 name 作为标识
        name: h.name,
        source: h.source,
        score: h.similarity ?? h.score,
        contentPreview: h.contentPreview,
      }));
      uiManager.renderMemoryList(items);
    } catch {
      // 搜索失败时保持原列表
    }
  });

  // 筛选回调
  uiManager.onMemoryFilter((_source: string) => {
    void loadMemoryList();
  });

  // 点击记忆条目：查看详情
  uiManager.onMemoryClick(async (id: string) => {
    try {
      const { memory } = await window.electronAPI.showMemory(id);
      if (memory) {
        uiManager.showMemoryDetail(memory as MemoryDetail);
      }
    } catch {
      // ignore
    }
  });

  // 删除记忆
  uiManager.onMemoryDelete(async () => {
    const id = uiManager.getCurrentMemoryId();
    if (!id) return;
    try {
      await window.electronAPI.deleteMemory(id);
      uiManager.hideModal('memory-detail-modal');
      await loadMemoryList();
    } catch {
      // ignore
    }
  });

  // 添加记忆
  uiManager.onMemoryAdd(async (data) => {
    try {
      await window.electronAPI.addMemory(data);
      uiManager.clearAddMemoryForm();
      uiManager.hideModal('memory-add-modal');
      await loadMemoryList();
    } catch {
      // ignore
    }
  });
}

/** 加载记忆列表 */
async function loadMemoryList(): Promise<void> {
  try {
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement | null;
    const source = filterEl?.value || undefined;
    const { memories } = await window.electronAPI.listMemories(source ? { source } : {});
    uiManager.renderMemoryList(memories as MemoryListItem[]);

    // 更新仪表盘记忆计数
    const countEl = document.getElementById('memory-count');
    if (countEl) {
      countEl.textContent = String((memories as unknown[]).length);
    }
  } catch {
    // ignore
  }
}

// ─── 角色选择器业务逻辑 ───────────────────────────────────

/** 设置角色选择器回调 */
function setupPersonaSelector(): void {
  uiManager.onPersonaSwitch(async (name: string) => {
    try {
      const { switched, name: activeName } = await window.electronAPI.switchPersona(name);
      if (switched && activeName) {
        uiManager.updateActivePersona(activeName);
      }
    } catch {
      // ignore
    }
  });
}

/** 加载角色列表 */
async function loadPersonaList(): Promise<void> {
  try {
    const { personas } = await window.electronAPI.listPersonas();
    uiManager.renderPersonaDropdown(personas);

    // 更新当前角色显示
    const active = personas.find(p => p.active);
    if (active) {
      uiManager.updateActivePersona(active.name);
    }
  } catch {
    // ignore
  }
}

// ─── 设置面板业务逻辑 ─────────────────────────────────────

/** 设置设置面板回调 */
function setupSettingsPanel(): void {
  uiManager.onConfigSave(async (config: SpriteConfigForm) => {
    try {
      // 逐项更新配置（sprite.updateConfig 一次只更新一个键）
      await window.electronAPI.updateConfig('silentMode', config.silentMode);
      await window.electronAPI.updateConfig('proactiveThreshold', config.proactiveThreshold);
      await window.electronAPI.updateConfig('proactiveCooldownMs', config.proactiveCooldownMs);
      await window.electronAPI.updateConfig('triggerIntervalMs', config.triggerIntervalMs);
      await window.electronAPI.updateConfig('fileWatcherEnabled', config.fileWatcherEnabled);
      await window.electronAPI.updateConfig('fileWatcherPaths', config.fileWatcherPaths);
      await window.electronAPI.updateConfig('fileWatcherDebounceMs', config.fileWatcherDebounceMs);
      await window.electronAPI.updateConfig('defaultPersona', config.defaultPersona);

      uiManager.appendMessage({
        role: 'system',
        content: '✓ 精灵配置已保存',
      });
    } catch (error) {
      uiManager.appendMessage({
        role: 'system',
        content: `⚠️ 保存精灵配置失败：${(error as Error).message}`,
      });
    }
  });

  // LLM 配置保存：调用 saveLlmConfig 触发主进程重新初始化 Agent
  uiManager.onLlmConfigSave(async (payload) => {
    // 校验必填字段
    if (!payload.llm.provider || !payload.llm.model || !payload.llm.apiKey) {
      uiManager.appendMessage({
        role: 'system',
        content: '⚠️ LLM 配置不完整：提供商、模型、API Key 为必填项',
      });
      return;
    }

    try {
      uiManager.appendMessage({
        role: 'system',
        content: '正在保存 LLM 配置并初始化 Agent...',
      });

      const embeddingConfig = payload.embedding?.enabled
        ? {
            model: payload.embedding.model,
            baseUrl: payload.embedding.baseUrl || undefined,
            apiKey: payload.embedding.apiKey || undefined,
          }
        : undefined;

      const { success, error } = await window.electronAPI.saveLlmConfig(
        {
          provider: payload.llm.provider,
          model: payload.llm.model,
          baseUrl: payload.llm.baseUrl,
          apiKey: payload.llm.apiKey,
          temperature: payload.llm.temperature,
        },
        embeddingConfig,
      );

      if (success) {
        uiManager.appendMessage({
          role: 'system',
          content: '✓ LLM 配置已保存，Agent 已就绪',
        });
      } else {
        uiManager.appendMessage({
          role: 'system',
          content: `⚠️ 初始化失败：${error}`,
        });
      }
    } catch (error) {
      uiManager.appendMessage({
        role: 'system',
        content: `⚠️ 保存 LLM 配置失败：${(error as Error).message}`,
      });
    }
  });

  uiManager.onConfigCancel(() => {
    // 取消时重新加载配置
    void loadConfig();
    void loadLlmConfig();
  });
}

/** 加载配置到表单 */
async function loadConfig(): Promise<void> {
  try {
    const { config } = await window.electronAPI.getConfig();
    const cfg = config as Record<string, unknown>;

    const formConfig: SpriteConfigForm = {
      silentMode: Boolean(cfg.silentMode),
      proactiveThreshold: Number(cfg.proactiveThreshold) || 3,
      proactiveCooldownMs: Number(cfg.proactiveCooldownMs) || 300_000,
      triggerIntervalMs: Number(cfg.triggerIntervalMs) || 3_600_000,
      fileWatcherEnabled: Boolean(cfg.fileWatcherEnabled),
      fileWatcherPaths: Array.isArray(cfg.fileWatcherPaths) ? (cfg.fileWatcherPaths as string[]) : ['.'],
      fileWatcherDebounceMs: Number(cfg.fileWatcherDebounceMs) || 1000,
      defaultPersona: String(cfg.defaultPersona ?? ''),
    };

    uiManager.loadConfigToForm(formConfig);
  } catch {
    // ignore
  }
}

/** 加载 LLM 配置到表单 */
async function loadLlmConfig(): Promise<void> {
  try {
    const data = await window.electronAPI.getLlmConfig();
    uiManager.loadLlmConfigToForm(data);
  } catch {
    // ignore
  }
}

// ─── Agent 就绪监听 ───────────────────────────────────────

/** 监听主进程 Agent 就绪通知（LLM 配置保存成功后触发） */
function initAgentReadyListener(): void {
  window.electronAPI.onAgentReady(() => {
    uiManager.appendMessage({
      role: 'system',
      content: '🎉 Agent 已就绪，可以开始对话了',
    });
    // Agent 就绪后加载会话历史和初始数据
    void loadSessionHistory();
    void loadMemoryList();
    void loadPersonaList();
  });
}