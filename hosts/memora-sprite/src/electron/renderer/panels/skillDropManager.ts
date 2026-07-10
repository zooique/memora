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
// 渲染进程统一日志入口（替代散落的 console.error/warn）
import { reportError } from '../helpers/errorHelpers.js';

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

    // 逐个安装（避免并发写入冲突）
    let successCount = 0;
    let lastError = '';
    for (const file of mdFiles) {
      const ok = await this.installSkillFile(file);
      if (ok) {
        successCount++;
      } else {
        lastError = lastError || '部分文件安装失败';
      }
    }

    // 汇总反馈
    if (successCount > 0) {
      const msg = successCount === 1
        ? '技能安装成功'
        : `${successCount} 个技能安装成功`;
      this.toastManager.showToast(msg, 'success', TOAST_NORMAL_MS);
      this.skillInstalledCallback?.();
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
   * @returns 是否安装成功
   */
  private async installSkillFile(file: File): Promise<boolean> {
    const dropzone = document.getElementById('skill-dropzone');
    if (!dropzone) return false;

    // 安装中态：降低透明度 + 禁用指针
    dropzone.classList.add('is-installing');
    try {
      // 读取文件内容（FileReader 同步读取为文本）
      const content = await this.readFileAsText(file);
      // 调用主进程 IPC 安装（校验 + 写入 configDir/skills/）
      const result = await window.electronAPI.installSkill(file.name, content);
      if (!result.success) {
        // 校验失败或写入失败，显示具体错误
        this.toastManager.showToast(`${file.name}：${result.error}`, 'error', TOAST_LONG_MS);
        return false;
      }
      return true;
    } catch (err) {
      // 读取文件或 IPC 调用异常
      const errMsg = err instanceof Error ? err.message : String(err);
      this.toastManager.showToast(`${file.name}：${errMsg}`, 'error', TOAST_LONG_MS);
      return false;
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
