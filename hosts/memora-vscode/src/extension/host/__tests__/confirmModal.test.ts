// @vitest-environment node
/**
 * 模态确认框唯一入口 · 单向判据回归测试
 *
 * 立此用例的血训（台账 `MODAL-DUP-CANCEL-1`）：调用点自拼「取消」item，与 VS Code modal
 * 自动追加的系统级 Cancel 叠成 `[覆盖] [取消] [取消]`；更危险的是判据方向——自带 Cancel
 * 解析为 `undefined`，若写成「不等于 `'取消'` 就确认」，一次真取消会被当成确认执行覆盖。
 *
 * 被测不变量：
 *   1. 只传**一个** item（confirmLabel），传参形式固定为 `(message, { modal: true }, item)`；
 *   2. 只有 `resolved === confirmLabel` 返回 true；
 *   3. `undefined`（自带 Cancel / Esc / 关 X）、`'取消'`、`'取消 '`、近似字符串一律 false；
 *   4. `detail` 缺省时 message 不带多余换行；有 detail 时用单换行拼接。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** vscode.window.showWarningMessage 的替身（每个用例前重置） */
const showWarningMessage = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  window: { showWarningMessage },
}));

import { confirmModal } from '../ui/confirmModal.js';

beforeEach(() => {
  showWarningMessage.mockReset();
});

describe('confirmModal', () => {
  it('只有严格等于 confirmLabel 才返回 true', async () => {
    showWarningMessage.mockResolvedValue('覆盖');
    await expect(confirmModal({ message: 'x', confirmLabel: '覆盖' })).resolves.toBe(true);
  });

  it.each([
    ['VS Code 自带 Cancel（undefined）', undefined],
    ['我们旧代码自拼的「取消」', '取消'],
    ['带尾空格的「取消」', '取消 '],
    ['近似确认文案（尾空格）', '覆盖 '],
    ['完全无关字符串', '删除'],
  ])('%s ⇒ false（不得判成确认）', async (_label, resolved) => {
    showWarningMessage.mockResolvedValue(resolved as string | undefined);
    await expect(confirmModal({ message: 'x', confirmLabel: '覆盖' })).resolves.toBe(false);
  });

  it('只传一个 item：取消项没有参数位', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    await confirmModal({ message: '主行', confirmLabel: '覆盖' });
    const args = showWarningMessage.mock.calls[0] as unknown[];
    expect(args).toHaveLength(3);
    expect(args[1]).toEqual({ modal: true });
    expect(args[2]).toBe('覆盖');
    // 反向守卫：任何取消类字面量都不得出现在实参里
    expect(args.some((arg) => typeof arg === 'string' && /取消|Cancel/i.test(arg))).toBe(false);
  });

  it('detail 缺省不带多余换行；有 detail 时单换行拼接', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    await confirmModal({ message: '主行', confirmLabel: '覆盖' });
    expect(showWarningMessage.mock.calls[0]![0]).toBe('主行');

    showWarningMessage.mockResolvedValue(undefined);
    await confirmModal({ message: '主行', confirmLabel: '覆盖', detail: '附行' });
    expect(showWarningMessage.mock.calls[1]![0]).toBe('主行\n附行');
  });
});
