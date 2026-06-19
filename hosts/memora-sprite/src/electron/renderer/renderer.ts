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
import type { MemoryListItem, SpriteConfigForm } from './ui.js';
import { toError } from 'memora';

// ─── 状态 ───────────────────────────────────────────────────

let uiManager: UIManager;

/** 静默模式定时恢复句柄（多次点击"静默 1 小时"时清理旧定时器，避免重复恢复） */
let silentRecoveryTimer: number | null = null;

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
  initAppErrorListener();
  initSpriteErrorListener();
  initFloatUnreadListener();
  initAgentReadyListener();

  // 初始化主动提示 banner 按钮（查看/稍后/静默）
  uiManager.initProactiveBannerButtons({
    onView: () => {
      // 已在对话面板内，仅确保面板可见
      uiManager.switchPanel('chat');
    },
    onLater: () => {
      // banner 已隐藏，无需额外操作
    },
    onSilent: () => {
      // 通知主进程进入静默模式（1 小时后自动恢复）
      void window.electronAPI.updateConfig('silentMode', true);
      // IX-06 操作反馈走 toast（静默模式是用户主动触发的状态变更）
      uiManager.showToast('已进入静默模式，精灵 1 小时内不会主动提示（到期自动恢复）', 'info');
      // 清理旧的恢复定时器，避免多次点击产生重复恢复
      if (silentRecoveryTimer !== null) {
        window.clearTimeout(silentRecoveryTimer);
      }
      // 设置本地定时器：1 小时后自动关闭静默模式
      // 注意：页面刷新会丢失定时器，但静默模式是持久化配置，用户可在设置面板手动关闭
      silentRecoveryTimer = window.setTimeout(() => {
        silentRecoveryTimer = null;
        void window.electronAPI.updateConfig('silentMode', false).then(() => {
          // IX-06 恢复提示走 toast
          uiManager.showToast('静默模式已到期自动恢复，精灵可正常主动提示', 'info');
        });
      }, 60 * 60 * 1000);
    },
  });

  // 召回记忆点击：跳转到记忆面板并显示详情
  uiManager.onMemoryRecallClick(async (memoryName) => {
    uiManager.switchPanel('memories');
    try {
      const { memory } = await window.electronAPI.showMemory(memoryName);
      if (memory) {
        uiManager.showMemoryDetail(memory);
      }
    } catch (error) {
      // 记忆可能已删除，记录日志辅助排查
      console.error('[memoryRecall] 查看记忆详情失败:', error);
    }
  });

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
  } catch (error) {
    // agent-status 通道不存在（旧版本兼容），记录日志后继续正常加载
    console.warn('[init] 查询 Agent 状态失败（可能为旧版本兼容）:', error);
  }

  // 加载初始数据
  await loadSessionHistory();
  void loadMemoryList();
  void loadPersonaList();
  void loadConfig();
  void loadDashboard();
});

// ─── 清理资源 ─────────────────────────────────────────────

// 页面卸载时清理资源：UI 监听器 + IPC 监听器
// IPC 监听器若不清理，重新加载页面时会累积，导致同一事件触发多次
window.addEventListener('beforeunload', () => {
  uiManager?.cleanup();
  // 清理 IPC 监听器（防止内存泄漏与重复触发）
  window.electronAPI?.removeStreamListeners();
  window.electronAPI?.removeSpriteOutputListener();
  window.electronAPI?.removeSpriteEventListener();
  window.electronAPI?.removeSpriteErrorListener();
  window.electronAPI?.removeAppErrorListener();
  window.electronAPI?.removeAgentReadyListener();
  window.electronAPI?.removeFloatUnreadListener();
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

  // FD-05 新建会话回调
  // 设计：精灵默认推荐"一个对话走到底"（上下文只用前三轮），
  // 但用户可能需要主动切换会话以开启全新上下文。
  // 此处通过确认对话框防止误操作，新会话创建后清空对话区并显示系统消息。
  uiManager.onNewSession(async () => {
    // 防止流式输出中创建新会话（避免上下文混乱）
    if (uiManager.isStreaming()) {
      // IX-06 操作反馈走 toast
      uiManager.showToast('精灵正在回复中，请等待回复完成或点击停止后再新建会话', 'warning');
      return;
    }

    // 确认对话框：清空当前对话区是不可逆的（但历史保留在 SessionStore）
    if (!window.confirm('开始新会话？\n\n当前对话将保留在历史中，可随时切换回来查看。')) {
      return;
    }

    try {
      const result = await window.electronAPI.newSession();
      if (result.success) {
        // 清空对话区并显示新会话提示（新会话提示是对话内容，保留在 #messages）
        uiManager.clearMessages();
        uiManager.appendMessage({
          role: 'system',
          content: `✨ 新会话已开始（${result.sessionName ?? ''}）`,
        });
      } else {
        // IX-06 失败反馈走 toast
        uiManager.showToast(`新建会话失败：${result.error ?? '未知错误'}`, 'error');
      }
    } catch (error) {
      uiManager.showToast(`新建会话失败：${toError(error).message}`, 'error');
    }
  });
}

// ─── 历史消息加载 ──────────────────────────────────────────

async function loadSessionHistory(): Promise<void> {
  try {
    const { messages } = await window.electronAPI.loadSession({});
    for (const msg of messages as Array<{ role: string; content: string }>) {
      // 保留合法角色，未知角色回退为 assistant（避免 system 被错误映射为 assistant）
      const role = (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system')
        ? msg.role as 'user' | 'assistant' | 'system'
        : 'assistant';
      uiManager.appendMessage({
        role,
        content: msg.content,
      });
    }
  } catch (error) {
    // 会话历史加载失败不影响主流程，记录日志辅助排查
    console.error('[loadSessionHistory] 加载会话历史失败:', error);
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

// ─── 精灵事件（统一监听，按 type 分发） ──────────────────────

/**
 * 精灵事件监听
 *
 * 对齐 docs/memora-sprite-preview.html：
 * - §6.3 memoryNoticed/insightGained → 仪表盘计数 +1 动画
 * - §6.6 proactivePrompt → 顶部滑入蓝粉渐变 banner（非静默模式）
 *
 * 注意：onSpriteEvent 在同一 IPC 通道上注册多次会导致同一事件触发多次。
 * 此处统一注册一个监听器，内部按 type 分发，避免重复触发。
 */
function initSpriteEventListener(): void {
  window.electronAPI.onSpriteEvent((msg) => {
    if (msg.type === 'memoryNoticed') {
      pulseCounter('memory-count');
      // FD-03 记忆变化后刷新仪表盘（累积事件数可能变化）
      void loadDashboard();
    } else if (msg.type === 'insightGained') {
      pulseCounter('insight-count');
      // FD-03 洞察变化后刷新仪表盘
      void loadDashboard();
    } else if (msg.type === 'proactivePrompt') {
      handleProactivePrompt(msg);
    }
  });
}

/**
 * 处理主动提示事件
 *
 * 对齐 docs/memora-sprite-preview.html §6.6：
 * - 静默模式：仅更新托盘数字，不打扰用户
 * - 非静默模式：确保对话面板可见，然后显示蓝粉渐变 banner
 */
function handleProactivePrompt(msg: { type: string; payload: unknown; silent: boolean }): void {
  const payload = msg.payload as { prompt: string; triggers: string[]; silent: boolean };

  if (payload.silent) {
    // 静默模式：仅更新数字，不弹窗（由托盘在 ipcHandlers 层处理）
    return;
  }

  // 非静默模式：确保对话面板可见，然后显示 banner
  if (uiManager.getCurrentPanel() !== 'chat') {
    uiManager.switchPanel('chat');
  }
  uiManager.showProactiveBanner(payload.prompt);

  // 通知主进程：主动提示已显示（用于清除未读计数）
  window.electronAPI.proactivePromptShown();
}

/** 仪表盘计数 +1 并触发脉冲动画（对齐 HTML 预览 §6.3 .stat-value.pulse） */
function pulseCounter(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(parseInt(el.textContent ?? '0') + 1);
  el.classList.add('pulse');
  setTimeout(() => el.classList.remove('pulse'), 300);
}

// ─── 应用错误处理 ─────────────────────────────────────────

function initAppErrorListener(): void {
  window.electronAPI.onAppError((error: AppError) => {
    // IX-06 应用级错误走 toast，不污染对话历史
    uiManager.showToast(error.message, 'error');
    console.error(`[${error.code}] ${error.message}`, error);
  });
}

/**
 * 精灵错误监听
 *
 * 监听 'sprite-error' 通道（ipcHandlers.ts 在对话流式输出出错时发送）。
 * 与 app-error（应用级错误）区分：sprite-error 是对话级错误。
 * IX-06 统一走 toast 通知，保持错误反馈渠道一致。
 */
function initSpriteErrorListener(): void {
  window.electronAPI.onSpriteError((msg: { text: string }) => {
    uiManager.showToast(msg.text, 'error');
    console.error('[sprite-error]', msg.text);
  });
}

// ─── 浮动窗口未读计数 ─────────────────────────────────────

/**
 * 浮动窗口未读计数同步
 *
 * 主进程在浮动窗口收到新消息时推送 count 到完整窗口。
 * 完整窗口的徽章由 UIManager 内部维护（appendMessage 时累加），
 * 此处仅同步主进程的权威计数，避免双窗口计数不一致。
 *
 * 注意：原实现错误地在对话区追加"精灵有 N 条新消息"系统消息，
 * 会污染对话历史。已改为仅更新徽章。
 */
function initFloatUnreadListener(): void {
  window.electronAPI.onFloatUnread((count: number) => {
    // 直接同步主进程的未读计数到徽章
    // UIManager.clearUnreadCount() 会清零，此处需要补充设置方法
    uiManager.setUnreadCount(count);
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
      const items: MemoryListItem[] = hits.map(h => ({
        id: h.id,
        name: h.name,
        source: h.source,
        score: h.similarity ?? h.score,
        contentPreview: h.contentPreview,
      }));
      uiManager.renderMemoryList(items);
    } catch (error) {
      // 搜索失败时保持原列表，记录日志辅助排查
      console.error('[onMemorySearch] 记忆搜索失败:', error);
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
        uiManager.showMemoryDetail(memory);
      }
    } catch (error) {
      console.error('[onMemoryClick] 查看记忆详情失败:', error);
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
      // IX-06 操作反馈走 toast
      uiManager.showToast('记忆已删除', 'success');
    } catch (error) {
      console.error('[onMemoryDelete] 删除记忆失败:', error);
      uiManager.showToast(`删除记忆失败：${toError(error).message}`, 'error');
    }
  });

  // 添加记忆
  uiManager.onMemoryAdd(async (data) => {
    // FD-08 进行中反馈：禁用按钮防止重复点击
    uiManager.setButtonLoading('btn-memory-add-confirm', true, '添加中...');
    try {
      await window.electronAPI.addMemory(data);
      uiManager.clearAddMemoryForm();
      uiManager.hideModal('memory-add-modal');
      await loadMemoryList();
      // IX-06 操作反馈走 toast
      uiManager.showToast('记忆已添加', 'success');
    } catch (error) {
      console.error('[onMemoryAdd] 添加记忆失败:', error);
      uiManager.showToast(`添加记忆失败：${toError(error).message}`, 'error');
    } finally {
      // FD-08 恢复按钮状态
      uiManager.setButtonLoading('btn-memory-add-confirm', false);
    }
  });
}

/** 加载记忆列表 */
async function loadMemoryList(): Promise<void> {
  try {
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement | null;
    const source = filterEl?.value || undefined;
    const { memories } = await window.electronAPI.listMemories(source ? { source } : {});
    uiManager.renderMemoryList(memories);

    // 更新仪表盘记忆计数
    const countEl = document.getElementById('memory-count');
    if (countEl) {
      countEl.textContent = String(memories.length);
    }
  } catch (error) {
    console.error('[loadMemoryList] 加载记忆列表失败:', error);
  }
}

/**
 * FD-03 加载完整仪表盘数据
 *
 * 对齐 CLI /dashboard 命令，在侧边栏仪表盘显示：
 * - 累积事件数 / 主动提示阈值（接近阈值黄色，达到阈值粉色）
 * - 已注册触发器数量（hover 看触发器名称列表）
 */
async function loadDashboard(): Promise<void> {
  try {
    const data = await window.electronAPI.getDashboard();

    // 累积事件数 / 阈值
    const pendingEl = document.getElementById('pending-count');
    const dashPending = document.getElementById('dash-pending');
    if (pendingEl && dashPending) {
      pendingEl.textContent = `${data.pendingNotices}/${data.proactiveThreshold}`;
      // 高亮状态：接近阈值（>=80%）黄色，达到阈值粉色
      dashPending.classList.remove('near-threshold', 'at-threshold');
      if (data.pendingNotices >= data.proactiveThreshold) {
        dashPending.classList.add('at-threshold');
      } else if (data.proactiveThreshold > 0
        && data.pendingNotices / data.proactiveThreshold >= 0.8) {
        dashPending.classList.add('near-threshold');
      }
    }

    // 已注册触发器数量 + hover 详情
    const triggerEl = document.getElementById('trigger-count');
    const dashTriggers = document.getElementById('dash-triggers');
    if (triggerEl && dashTriggers) {
      triggerEl.textContent = String(data.registeredTriggers.length);
      // hover 显示触发器名称列表
      const triggerList = data.registeredTriggers.length > 0
        ? data.registeredTriggers.join(', ')
        : '无触发器';
      dashTriggers.title = `已注册触发器：${triggerList}`;
    }
  } catch (error) {
    console.error('[loadDashboard] 加载仪表盘数据失败:', error);
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
        // IX-06 操作反馈走 toast
        uiManager.showToast(`已切换到角色：${activeName}`, 'success');
      }
    } catch (error) {
      console.error('[onPersonaSwitch] 切换角色失败:', error);
      uiManager.showToast(`切换角色失败：${toError(error).message}`, 'error');
    }
  });

  // IX-07 角色匹配模式变更：实时持久化 + 更新标签
  uiManager.onPersonaModeChange(async (mode: string) => {
    try {
      const { set } = await window.electronAPI.setPersonaMode(mode as 'auto' | 'manual');
      if (set) {
        uiManager.showToast(`角色匹配模式已切换为：${mode === 'auto' ? '自动' : '手动'}`, 'success');
      } else {
        uiManager.showToast('角色匹配模式切换失败', 'error');
      }
    } catch (error) {
      console.error('[onPersonaModeChange] 设置角色模式失败:', error);
      uiManager.showToast(`设置角色模式失败：${toError(error).message}`, 'error');
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

    // IX-07 加载当前角色匹配模式并更新标签
    try {
      const { mode } = await window.electronAPI.getPersonaMode();
      uiManager.updatePersonaModeBadge(mode);
      uiManager.setPersonaMode(mode);
    } catch (modeErr) {
      console.error('[loadPersonaList] 加载角色模式失败:', modeErr);
    }
  } catch (error) {
    console.error('[loadPersonaList] 加载角色列表失败:', error);
  }
}

// ─── 设置面板业务逻辑 ─────────────────────────────────────

/** 设置设置面板回调 */
function setupSettingsPanel(): void {
  uiManager.onConfigSave(async (config: SpriteConfigForm) => {
    // FD-08 进行中反馈：禁用保存按钮防止重复点击
    uiManager.setButtonLoading('btn-settings-save', true, '保存中...');
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
      // FD-04 项目模式：先更新路径再切换模式（确保专注模式切换时路径已就绪）
      await window.electronAPI.updateConfig('focusProjectPath', config.focusProjectPath);
      await window.electronAPI.updateConfig('projectMode', config.projectMode);

      // IX-06 操作反馈走 toast，不污染对话历史
      uiManager.showToast('精灵配置已保存', 'success');
    } catch (error) {
      uiManager.showToast(`保存精灵配置失败：${toError(error).message}`, 'error');
    } finally {
      // FD-08 恢复按钮状态
      uiManager.setButtonLoading('btn-settings-save', false);
    }
  });

  // LLM 配置保存：调用 saveLlmConfig 触发主进程重新初始化 Agent
  uiManager.onLlmConfigSave(async (payload) => {
    // 校验必填字段
    if (!payload.llm.provider || !payload.llm.model || !payload.llm.apiKey) {
      uiManager.showToast('LLM 配置不完整：提供商、模型、API Key 为必填项', 'warning');
      return;
    }

    // FD-08 进行中反馈：禁用保存按钮防止重复点击
    uiManager.setButtonLoading('btn-settings-save', true, '保存中...');
    try {
      // IX-06 进行中反馈走 toast（不自动消失，等结果出来后由成功/失败 toast 替换）
      uiManager.showToast('正在保存 LLM 配置并初始化 Agent...', 'info', 0);

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
        uiManager.showToast('LLM 配置已保存，Agent 已就绪', 'success');
      } else {
        uiManager.showToast(`初始化失败：${error}`, 'error');
      }
    } catch (error) {
      uiManager.showToast(`保存 LLM 配置失败：${toError(error).message}`, 'error');
    } finally {
      // FD-08 恢复按钮状态
      uiManager.setButtonLoading('btn-settings-save', false);
    }
  });

  uiManager.onConfigCancel(() => {
    // 取消时重新加载配置
    void loadConfig();
    void loadLlmConfig();
  });

  // LLM 连接测试：调用主进程验证配置，显示结果
  uiManager.onLlmTest(async () => {
    const config = uiManager.getLlmConfigFromForm();
    if (!config.provider || !config.model || !config.apiKey) {
      uiManager.showLlmTestResult({
        success: false,
        error: '提供商、模型、API Key 为必填项',
      });
      return;
    }

    // FD-08 进行中反馈：禁用测试按钮防止重复点击
    uiManager.setButtonLoading('btn-llm-test', true, '测试中...');
    // 显示"测试中..."状态
    uiManager.showLlmTestResult({ success: false, error: '测试中...' });
    const startTime = Date.now();

    try {
      const result = await window.electronAPI.testLlmConfig(config);
      const elapsed = Date.now() - startTime;
      uiManager.showLlmTestResult(result, elapsed);
    } catch (error) {
      uiManager.showLlmTestResult({
        success: false,
        error: toError(error).message,
      });
    } finally {
      // FD-08 恢复按钮状态
      uiManager.setButtonLoading('btn-llm-test', false);
    }
  });
}

/** 加载配置到表单 */
async function loadConfig(): Promise<void> {
  try {
    const { config: cfg } = await window.electronAPI.getConfig();

    const formConfig: SpriteConfigForm = {
      silentMode: Boolean(cfg.silentMode),
      proactiveThreshold: Number(cfg.proactiveThreshold) || 3,
      proactiveCooldownMs: Number(cfg.proactiveCooldownMs) || 300_000,
      triggerIntervalMs: Number(cfg.triggerIntervalMs) || 3_600_000,
      fileWatcherEnabled: Boolean(cfg.fileWatcherEnabled),
      fileWatcherPaths: Array.isArray(cfg.fileWatcherPaths) ? cfg.fileWatcherPaths : ['.'],
      fileWatcherDebounceMs: Number(cfg.fileWatcherDebounceMs) || 1000,
      defaultPersona: String(cfg.defaultPersona ?? ''),
      // FD-04 项目模式字段
      projectMode: cfg.projectMode === 'focus' ? 'focus' : 'smart',
      focusProjectPath: String(cfg.focusProjectPath ?? ''),
    };

    uiManager.loadConfigToForm(formConfig);

    // FD-04 加载项目列表到专注项目下拉框
    try {
      const { projects } = await window.electronAPI.listProjects();
      uiManager.loadProjectsToForm(projects, formConfig.focusProjectPath);
    } catch (err) {
      console.error('[loadConfig] 加载项目列表失败:', err);
    }

    // FD-07 程序化设置表单值会触发 input/change 事件，重置 dirty 标志
    uiManager.resetSettingsFormDirty();
  } catch (error) {
    console.error('[loadConfig] 加载精灵配置失败:', error);
  }
}

/** 加载 LLM 配置到表单 */
async function loadLlmConfig(): Promise<void> {
  try {
    const data = await window.electronAPI.getLlmConfig();
    uiManager.loadLlmConfigToForm(data);
    // FD-07 程序化设置表单值会触发 input/change 事件，重置 dirty 标志
    uiManager.resetSettingsFormDirty();
  } catch (error) {
    console.error('[loadLlmConfig] 加载 LLM 配置失败:', error);
  }
}

// ─── Agent 就绪监听 ───────────────────────────────────────

/** 监听主进程 Agent 就绪通知（LLM 配置保存成功后触发） */
function initAgentReadyListener(): void {
  window.electronAPI.onAgentReady(() => {
    // IX-06 Agent 就绪是操作反馈（LLM 配置保存后触发），走 toast
    uiManager.showToast('Agent 已就绪，可以开始对话了', 'success');
    // Agent 就绪后加载会话历史和初始数据
    void loadSessionHistory();
    void loadMemoryList();
    void loadPersonaList();
    void loadDashboard();
  });
}