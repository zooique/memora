/**
 * 技能拖入安装面板管理器
 *
 * 从 UIManager 拆分（约 150 行），统一管理"技能文件拖入安装"功能的 UI 联动。
 *
 * 职责：
 * - 注册技能安装成功回调（由 renderer.ts 调用以刷新技能列表）
 * - 处理拖入的 .md 技能文件（多文件逐个安装，避免并发写入冲突）
 * - 触发文件选择对话框（dropzone click 时打开隐藏 <input type="file">）
 * - 读取 File 为文本（Promise 包装 FileReader）
 * - 短暂闪烁 dropzone 错误态（添加 .is-error 类触发抖动动画）
 *
 * 设计原则：
 * - 依赖注入 ToastManager 实例，与 UIManager 共享同一引用，行为与拆分前一致
 * - 不绑定 DOM 事件（事件绑定在 renderer.ts 中），无需 EventTracker
 * - 公共 API：onSkillInstalled / handleSkillDrop / handleSkillFileSelect
 */

import type { ToastManager } from '../components/toast.js';
// 精灵公共常量（Toast 时长，跨进程共享 DRY）
import { TOAST_SHORT_MS, TOAST_NORMAL_MS, TOAST_LONG_MS } from '../../../sprite/constants.js';
// 渲染进程统一日志入口 + toError 工具（errorHelpers re-export 自 shared/toError，纯函数零依赖）
import { reportError, toError } from '../helpers/errorHelpers.js';

/**
 * 技能拖入安装面板管理器类
 *
 * 职责：处理 .md 技能文件拖入/选择 → 读取内容 → IPC 安装 → 反馈结果
 * 依赖：ToastManager（安装进度/结果提示）
 * 生命周期：无事件监听器（事件在 renderer.ts 中注册），cleanup() 清空回调引用
 */
export class SkillDropManager {
  /**
   * 构造函数：注入共享的 Toast 管理器实例
   *
   * @param toastManager Toast 通知管理器（与 UIManager 同一引用，用于显示安装进度/结果提示）
   */
  constructor(
    /** 共享的 Toast 管理器实例（与 UIManager 同一引用） */
    private readonly toastManager: ToastManager,
  ) {}

  /** 技能安装成功回调（由 renderer.ts 注册，用于刷新技能列表） */
  private skillInstalledCallback: (() => void) | null = null;

  /**
   * 注册技能安装成功回调
   *
   * 安装成功后调用，renderer.ts 在此回调中刷新技能列表（loadDashboard）。
   * 与 onSendMessage 同模式，保持回调注册风格一致。
   */
  onSkillInstalled(callback: () => void): void {
    this.skillInstalledCallback = callback;
  }

  /**
   * 处理拖入的技能文件
   *
   * 由 dropzone 的 drop 事件触发。校验文件类型后调用 installSkillFile。
   * 多文件场景下逐个安装，任一失败不中断后续文件。
   *
   * 反馈策略（与主进程热重载结果对齐）：
   * - 文件写入失败 → error toast + flashDropzoneError
   * - 文件写入成功 + 热重载成功 → success toast "技能安装成功，已生效"
   * - 文件写入成功 + 热重载失败（如对话繁忙） → warning toast "技能已安装，重启后生效"
   * - 文件写入成功 + 无 Agent（首次启动未配置 LLM） → info toast "技能已安装，Agent 就绪后生效"
   *
   * @param files 拖入的文件列表
   */
  async handleSkillDrop(files: File[]): Promise<void> {
    if (files.length === 0) return;

    // 过滤非 .md 文件（拖入多文件时可能混入其他类型）
    const mdFiles = files.filter((f) => f.name.toLowerCase().endsWith('.md'));
    if (mdFiles.length === 0) {
      this.toastManager.showToast('仅支持 .md 技能文件', 'warning');
      this.flashDropzoneError();
      return;
    }
    if (mdFiles.length < files.length) {
      // 部分文件被跳过，提示用户
      const skipped = files.length - mdFiles.length;
      this.toastManager.showToast(`已跳过 ${skipped} 个非 .md 文件`, 'info', TOAST_SHORT_MS);
    }

    // 逐个安装（避免并发写入冲突），累计热重载结果用于汇总反馈
    let successCount = 0;
    let hotReloadFailedCount = 0;
    let noAgentCount = 0;
    let lastError = '';
    for (const file of mdFiles) {
      const result = await this.installSkillFile(file);
      if (result === 'failed') {
        // 文件写入或校验失败：lastError 已在 installSkillFile 内 toast，此处仅记录汇总
        lastError = lastError || '部分文件安装失败';
        continue;
      }
      // 文件写入成功，根据热重载结果分类计数
      successCount++;
      if (result === 'hot-reload-failed') {
        hotReloadFailedCount++;
      } else if (result === 'no-agent') {
        noAgentCount++;
      }
    }

    // 汇总反馈：按"最严重情况"优先级提示（失败 > 无 Agent > 热重载失败 > 全成功）
    if (successCount > 0) {
      this.skillInstalledCallback?.();
      // 全部热重载成功 → success toast
      if (hotReloadFailedCount === 0 && noAgentCount === 0) {
        const msg = successCount === 1
          ? '技能安装成功，已生效'
          : `${successCount} 个技能安装成功，已生效`;
        this.toastManager.showToast(msg, 'success', TOAST_NORMAL_MS);
      } else if (noAgentCount === successCount) {
        // 全部无 Agent（首次启动未配置 LLM）：技能已写入文件，Agent 就绪后自动加载
        const msg = successCount === 1
          ? '技能已安装，Agent 就绪后生效'
          : `${successCount} 个技能已安装，Agent 就绪后生效`;
        this.toastManager.showToast(msg, 'info', TOAST_NORMAL_MS);
      } else if (hotReloadFailedCount > 0) {
        // 部分或全部热重载失败（如对话繁忙）：文件已落盘，重启后生效
        const msg = hotReloadFailedCount === successCount
          ? (successCount === 1
              ? '技能已安装，重启后生效（当前对话进行中）'
              : `${successCount} 个技能已安装，重启后生效（当前对话进行中）`)
          : `${successCount} 个技能已安装，${hotReloadFailedCount} 个需重启生效（对话进行中）`;
        this.toastManager.showToast(msg, 'warning', TOAST_LONG_MS);
      }
    }
    if (lastError) {
      this.toastManager.showToast(lastError, 'error', TOAST_LONG_MS);
      this.flashDropzoneError();
    }
  }

  /**
   * 触发文件选择对话框
   *
   * 由 dropzone 的 click 事件触发。打开隐藏的 <input type="file">，
   * 用户选择文件后由 change 事件处理（在 renderer.ts 中注册）。
   */
  handleSkillFileSelect(): void {
    const fileInput = document.getElementById('skill-file-input');
    if (fileInput instanceof HTMLInputElement) {
      fileInput.click();
    } else {
      reportError('SkillDrop skill-file-input 元素缺失', new Error('文件选择不可用：HTMLInputElement 校验失败'));
    }
  }

  /**
   * 安装单个技能文件
   *
   * 内部方法，执行实际的文件读取 + IPC 调用 + 状态反馈。
   * 安装期间添加 .is-installing 类禁用 dropzone，避免重复触发。
   *
   * @param file 待安装的 .md 文件
   * @returns 安装结果分类：
   *   - 'failed'：文件读取或 IPC 调用失败（错误 toast 已在本方法内显示）
   *   - 'hot-reloaded'：文件写入成功 + 热重载成功，当前会话已生效
   *   - 'hot-reload-failed'：文件写入成功 + 热重载失败（如对话繁忙），需重启生效
   *   - 'no-agent'：文件写入成功 + 无 Agent 实例，将在 Agent 就绪后自动加载
   */
  private async installSkillFile(
    file: File,
  ): Promise<'failed' | 'hot-reloaded' | 'hot-reload-failed' | 'no-agent'> {
    const dropzone = document.getElementById('skill-dropzone');
    if (!dropzone) return 'failed';

    // 安装中态：降低透明度 + 禁用指针
    dropzone.classList.add('is-installing');
    try {
      // 读取文件内容（FileReader 同步读取为文本）
      const content = await this.readFileAsText(file);
      // 调用主进程 IPC 安装（校验 + 写入 configDir/skills/ + 热重载）
      const result = await window.electronAPI.installSkill(file.name, content);
      if (!result.success) {
        // 校验失败或写入失败，显示具体错误
        this.toastManager.showToast(`${file.name}：${result.error}`, 'error', TOAST_LONG_MS);
        return 'failed';
      }
      // 文件写入成功：根据热重载结果分类返回
      if (result.hotReloaded === true) {
        return 'hot-reloaded';
      }
      if (result.hotReloaded === false) {
        // 热重载失败原因已由主进程透传，此处不重复 toast（汇总在 handleSkillDrop 中处理）
        return 'hot-reload-failed';
      }
      // hotReloaded === undefined：无 Agent 实例（首次启动未配置 LLM）
      return 'no-agent';
    } catch (err) {
      // 读取文件或 IPC 调用异常
      const errMsg = toError(err).message;
      this.toastManager.showToast(`${file.name}：${errMsg}`, 'error', TOAST_LONG_MS);
      return 'failed';
    } finally {
      // 无论成功失败，移除安装中态
      dropzone.classList.remove('is-installing');
    }
  }

  /**
   * 读取 File 为文本（Promise 包装 FileReader）
   *
   * @param file 待读取的文件
   * @returns 文件文本内容
   */
  private readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result;
        if (typeof text === 'string') {
          resolve(text);
        } else {
          reject(new Error('文件内容非文本'));
        }
      };
      reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
      reader.readAsText(file);
    });
  }

  /**
   * 短暂闪烁 dropzone 错误态
   *
   * 添加 .is-error 类触发抖动动画，400ms 后移除。
   * 与 CSS @keyframes skill-dropzone-shake 时长一致。
   */
  private flashDropzoneError(): void {
    const dropzone = document.getElementById('skill-dropzone');
    if (!dropzone) return;
    dropzone.classList.add('is-error');
    // 动画结束后移除类（与 CSS animation 时长一致）
    window.setTimeout(() => {
      dropzone.classList.remove('is-error');
    }, 400);
  }

  /**
   * 清理资源
   *
   * SkillDropManager 不持有事件监听器，无需实际清理。
   * 提供空实现以与其他 Manager 保持统一的生命周期接口，
   * 同时清空回调引用避免潜在内存泄漏。
   */
  cleanup(): void {
    this.skillInstalledCallback = null;
  }
}
