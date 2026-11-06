/**
 * PanelSnapshots · 后台任务条的会话隔离（BGTASK-DISMISS-CROSSTALK-1）
 *
 * 钉死两件事：
 *   ① `taskId` 是**每实例序号**（`bg-${seq}`），两个会话都会出现 `bg-1` ⇒ 收起 A 的
 *      `bg-1` 不得连带隐藏 B 的同名任务（收起偏好必须按会话分桶）；
 *   ② 切会话首推不得被旧签名吞掉——即使两会话快照内容完全相同，条上的内容也属于上一会话。
 *
 * 判据可因实现退化转红：把 `_dismissedBySession` 改回全局 Set，用例①第三段转红；
 * 去掉 `sessionChanged` 哨兵，用例②第二段转红。
 */
import { describe, expect, it } from 'vitest';
import type { Agent } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../../shared/protocol.js';
import { PanelSnapshots } from '../panelSnapshots.js';

/** 后台任务推送消息（取联合类型中的一支，避免手写结构漂移） */
type BackgroundTasksMessage = Extract<ExtensionToWebviewMessage, { type: 'background_tasks' }>;

/**
 * 构造只暴露 `listBackgroundTasks` 的最小 agent 替身
 *
 * @param taskIds 该实例注册表中的任务标识（两会话都从 bg-1 起号，复现真实重名场景）
 */
function makeAgent(taskIds: string[]): Agent {
  return {
    listBackgroundTasks: () =>
      taskIds.map((taskId) => ({ taskId, command: `cmd ${taskId}`, status: 'running' })),
  } as unknown as Agent;
}

/**
 * 取最近一条后台任务推送里的 taskId 列表
 *
 * @param posted 已投递的全部消息
 */
function lastTaskIds(posted: ExtensionToWebviewMessage[]): string[] {
  for (let i = posted.length - 1; i >= 0; i -= 1) {
    const msg = posted[i]!;
    if (msg.type === 'background_tasks') {
      return (msg as BackgroundTasksMessage).items.map((item) => item.taskId);
    }
  }
  return [];
}

describe('PanelSnapshots · 后台任务条跨会话隔离', () => {
  it('A 收起的 bg-1 在 B 里仍显示（收起偏好按会话分桶）', () => {
    /** 当前显示会话（用例内可变，模拟切会话） */
    let sessionId = 'sess-A';
    /** 投递记录 */
    const posted: ExtensionToWebviewMessage[] = [];
    const snapshots = new PanelSnapshots({
      getAgent: () => makeAgent(['bg-1', 'bg-2']),
      post: (msg) => posted.push(msg),
      isBackground: () => false,
      getSessionId: () => sessionId,
    });

    snapshots.pushTasks('force');
    expect(lastTaskIds(posted)).toEqual(['bg-1', 'bg-2']);

    // A 里收起 bg-1：只剩 bg-2
    snapshots.dismiss('bg-1');
    expect(lastTaskIds(posted)).toEqual(['bg-2']);

    // 切到 B：同名 bg-1 是 B 的另一条任务，必须仍显示（全局 Set 实现会在这里转红）
    sessionId = 'sess-B';
    snapshots.pushTasks('force');
    expect(lastTaskIds(posted)).toEqual(['bg-1', 'bg-2']);

    // 切回 A：A 的收起偏好仍在（选「按会话分桶」而非「切会话重置」的理由）
    sessionId = 'sess-A';
    snapshots.pushTasks('force');
    expect(lastTaskIds(posted)).toEqual(['bg-2']);
  });

  it('切会话首推不被旧签名吞掉（两会话快照内容完全相同也照推）', () => {
    /** 当前显示会话（用例内可变） */
    let sessionId = 'sess-A';
    /** 投递记录 */
    const posted: ExtensionToWebviewMessage[] = [];
    const snapshots = new PanelSnapshots({
      getAgent: () => makeAgent(['bg-1']),
      post: (msg) => posted.push(msg),
      isBackground: () => false,
      getSessionId: () => sessionId,
    });

    // A 首次推送落签名
    snapshots.pushTasks();
    const afterFirstPush = posted.length;
    // 同会话同内容 ⇒ 去重，不重复推
    snapshots.pushTasks();
    expect(posted.length).toBe(afterFirstPush);

    // 切到 B：内容签名与 A 完全相同，但必须推（去掉 sessionChanged 哨兵会在这里转红）
    sessionId = 'sess-B';
    snapshots.pushTasks();
    expect(posted.length).toBe(afterFirstPush + 1);
  });
});
