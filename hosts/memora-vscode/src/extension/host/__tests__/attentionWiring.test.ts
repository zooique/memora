/**
 * 交互提醒**接线守卫**（HOST-ATTN-1）
 *
 * 为什么需要本文件：提醒的判据已由 `attentionNotice.test.ts` 全覆盖，但「判据正确」
 * 不等于「判据被接上线」。接线落在 `chatPanel.ts` —— ask / done 两个触发点 + confirm
 * 注入点（import vscode，node 环境不可加载，测不了行为，故用源码文本锚定）。
 * 红线：**这类守卫只锚「契约串」，不锚实现细节**——前者改了必须同步改测试（正是意图），
 * 后者重构时会误红。
 *
 * 🔴 本文件守的实测坑（2026-10-22）：系统 toast 通道整体退役（借 AUMID 被系统静默丢弃，
 * 详见 `attentionNotice.ts` 头注释）。本守卫锁住两件事：
 *   ① toast 通道**不得复活**——`systemToast` / WinRT toast 相关字面量在提醒链路上必须
 *      保持为零，防止有人在没读实证结论的情况下把死通道接回来；
 *   ② 三个触发点**不得丢失**——面板内的承接面（审批卡 / ask 卡 / 完成状态）是提醒的
 *      判据前提，接线断了提醒就永远不响。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST_ROOT = join(__dirname, '..', '..', '..', '..');
const read = (...segments: string[]) => readFileSync(join(HOST_ROOT, ...segments), 'utf8');

/**
 * 去注释后再断言
 *
 * 守卫要锁的是「**代码里**没有」，而注释里写「原 toast 已删」是必要记录（不写就没人
 * 知道为什么只剩一条通道）。不剥离注释 ⇒ 守卫把说明文字当违规，实测踩过。
 */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

describe('chatPanel.ts：三个触发点接线', () => {
  const src = read('src', 'webview', 'panels', 'chatPanel.ts');

  it('confirm：onConfirmShown 注入确认协调器（只取 requestId，label 留在协调器）', () => {
    expect(src).toContain('onConfirmShown: (info) => this._attention.onConfirmShown({ requestId: info.requestId })');
  });

  it('ask：两个写入源各一处提醒（事件驱动 + 流尾兜底）', () => {
    // ⚠️ 计数是**故意的绊线**：ask 的写入源固定在两处（见 chatPanel 内注释）。新增写入源
    // 必须同步加提醒——本条会红，届时更新数字而不是删断言。
    const count = src.match(/_attention\.onAskWaiting\(/g)?.length ?? 0;
    expect(count).toBe(2);
  });

  it('done：本轮正常收场时提醒', () => {
    expect(src).toContain('this._attention.onRoundSettled({ roundId: latestRoundId })');
  });

  it('实例无参构造（判据只看窗口聚焦态，不依赖视图实例）', () => {
    expect(src).toContain('createVscodeAttention()');
    expect(src).not.toContain('createVscodeAttention(() => this._view)');
  });
});

describe('分层纪律：纯逻辑层不碰 vscode', () => {
  it('attentionNotice.ts 零 vscode 依赖（判据可单测的前提）', () => {
    const src = read('src', 'extension', 'host', 'attentionNotice.ts');
    expect(src).not.toMatch(/from ['"]vscode['"]/);
    expect(src).not.toMatch(/require\(['"]vscode['"]\)/);
  });

  it('vscodeAttention.ts 只做适配：不出现判据字面量，输出面走声音工厂', () => {
    const src = read('src', 'extension', 'host', 'vscodeAttention.ts');
    // 判据的真源在 attentionNotice.ts；这里出现判据字样说明逻辑漏到了适配层
    expect(src).not.toContain('isWindowFocused() &&');
    expect(src).toContain('playSound: createSystemSoundPlayer()');
  });
});

describe('系统 toast 通道已退役（2026-10-22 实证：借 AUMID 被静默丢弃）', () => {
  const notice = codeOf(read('src', 'extension', 'host', 'attentionNotice.ts'));
  const adapter = codeOf(read('src', 'extension', 'host', 'vscodeAttention.ts'));

  it('提醒链路上不得残留 toast 工厂 / WinRT 字面量（复活即红）', () => {
    expect(notice).not.toContain('systemToast');
    expect(notice).not.toContain('ToastNotification');
    expect(notice).not.toContain('showSystemToast');
    expect(adapter).not.toContain('systemToast');
    expect(adapter).not.toContain('ToastNotification');
  });

  it('systemToast.ts 文件本体已删除（重新引入必须先推翻实证结论）', () => {
    expect(() => read('src', 'extension', 'host', 'systemToast.ts')).toThrow();
  });

  it('URI 回跳契约随 toast 一并退役（无 toast 即无 launch 源）', () => {
    const ext = codeOf(read('src', 'extension', 'extension.ts'));
    expect(notice).not.toContain('ATTENTION_URI');
    expect(notice).not.toContain('launchUri');
    expect(ext).not.toContain('registerUriHandler');
  });

  it('workbench 通知与「去处理」按钮文案保持移除（更早的收敛不得回退）', () => {
    expect(notice).not.toContain('showInformationMessage');
    expect(notice).not.toContain('去处理');
    expect(adapter).not.toContain('showInformationMessage');
  });
});
