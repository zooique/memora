/**
 * 后台任务收口门面单测：验证统一计数（pending/completed/failed）与 onFailure 补救触发。
 * 门面用模块级单例状态，测试间用相对差值断言，避免用例间互相污染。
 */
import { describe, it, expect, vi } from 'vitest';
import { backgroundTask, getBackgroundTaskStats } from '@/utils/backgroundTask.js';

/** 取当前统计快照（相对差值基准） */
function snapshot() {
  return getBackgroundTaskStats();
}

describe('backgroundTask 后台任务收口', () => {
  it('成功任务累加 completed，完成后释放 pending', async () => {
    const before = snapshot();
    backgroundTask('success', () => Promise.resolve('ok'));
    await vi.waitFor(() => {
      const s = snapshot();
      expect(s.pending).toBe(before.pending);
      expect(s.completed).toBe(before.completed + 1);
    });
  });

  it('失败任务累加 failed，并触发 onFailure 传入错误原因', async () => {
    const before = snapshot();
    const onFailure = vi.fn();
    const boom = new Error('boom');
    backgroundTask('fail', () => Promise.reject(boom), onFailure);
    await vi.waitFor(() => {
      expect(getBackgroundTaskStats().failed).toBe(before.failed + 1);
    });
    expect(onFailure).toHaveBeenCalledWith(boom);
  });

  it('失败且未提供 onFailure 时静默降级（仅计数，不抛未捕获）', async () => {
    const before = snapshot();
    backgroundTask('fail-nohandler', () => Promise.reject(new Error('x')));
    await vi.waitFor(() => {
      expect(getBackgroundTaskStats().failed).toBe(before.failed + 1);
    });
  });
});
