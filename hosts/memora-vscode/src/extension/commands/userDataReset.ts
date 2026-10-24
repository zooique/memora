/**
 * 「恢复初始状态」处理器（清理用户级数据 + 重载窗口）
 *
 * 单一路径：命令面板入口（`memora.resetUserData`）与设置面板「安全」tab 按钮
 * 共用同一 handler —— 确认形态、清理顺序、reload 时机只有一处定义，
 * 杜绝两条路径漂移（按钮能清、命令漏 reload 之类）。
 *
 * 清空范围 = 全部用户级存储（明细判据见 host/userDataReset.ts 四条通道）；
 * 项目级数据（.memora/ 记忆与会话、工作区 settings）一字节不碰——记忆与会话
 * 已经是项目的一部分（用户拍板）。
 *
 * 从 extension.ts 外置而来（零行为变更）：modal 文案与返回结构逐字保留
 * （settingsPanel 按 `cancelled` / `message` 分支出 Neutral / 错误提示）。
 */
import * as vscode from 'vscode';
import { resetUserData, type UserDataResetScope } from '../host/userDataReset.js';
import { toNoticeText } from '../host/noticeText.js';

/** 处理器返回结构（与 settingsPanel.setResetHandler 的结构化契约同形） */
export interface UserDataResetResult {
  /** 是否成功清理（成功即会触发窗口重载） */
  ok: boolean;
  /** 用户在确认弹窗主动取消（非失败，调用方做中性提示） */
  cancelled?: boolean;
  /** 结果说明（失败原因 / 已取消 / 成功概要） */
  message?: string;
}

/**
 * 创建「恢复初始状态」处理器
 *
 * reload 是「回首装态」的组成部分而非可选项：activeRolePack / rolePackTeams /
 * confirmWrites / confirmScripts 都是装配期读一次进内存，globalState 清了内存
 * 不跟着变 ⇒ 清理成功后必须重载窗口。
 *
 * @param scope 清理范围（globalState / secrets / 存储目录 / package.json）
 * @param output 输出通道（清理明细与失败原因留痕，只给概要提示不刷屏）
 * @returns 可直接注入 settingsPanel 与命令注册的 handler
 */
export function createUserDataResetHandler(
  scope: UserDataResetScope,
  output: vscode.OutputChannel,
): () => Promise<UserDataResetResult> {
  return async (): Promise<UserDataResetResult> => {
    // 不传显式「取消」：VS Code modal 自带系统级取消（取消钮 / Esc / 关闭 X），
    // 再传会出现双取消（真机截图实锤）；confirmed !== '确认初始化并重载' 已兼容 undefined
    const confirmed = await vscode.window.showWarningMessage(
      '将清空插件的全部用户级数据：\n' +
        '· 用户技能与用户角色包\n' +
        '· 大模型配置与 API Key\n' +
        '· 激活角色包、角色包组、安全开关与用户级设置\n\n' +
        '保留：当前项目的记忆与会话记录（.memora/）、项目设置。\n' +
        '清理完成后将自动重载窗口，进行中的对话会中断。此操作不可撤销。',
      { modal: true },
      '确认初始化并重载',
    );
    if (confirmed !== '确认初始化并重载') {
      return { ok: false, cancelled: true, message: '已取消' };
    }
    try {
      const report = await resetUserData(scope);
      // 明细落输出通道（可追溯），提示语只给概要（不刷屏）
      output.appendLine(
        `Memora 用户级数据初始化完成：globalState ${report.globalStateCleared.length} 键 / ` +
          `SecretStorage ${report.secretsCleared.length} 条 / settings ${report.settingsCleared.length} 键 / ` +
          `目录 ${report.dirsReset.length} 个`,
      );
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return { ok: true, message: '已清空用户级数据，窗口即将重载' };
    } catch (err) {
      const message = toNoticeText(err);
      output.appendLine(`Memora 用户级数据初始化失败：${message}`);
      return { ok: false, message: `初始化失败：${message}` };
    }
  };
}
