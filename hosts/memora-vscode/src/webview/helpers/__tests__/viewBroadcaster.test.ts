/**
 * 多视图广播器单测（HOSTED-SEAT-SESSION-1）
 *
 * 钉这些事：会话级投递按「目标会话」路由（绑 A 的附加视图只收 A、绑 B 的只收 B）；
 * 不传目标 / postRaw 是全局广播；助手窗气泡取景在投递层过滤过程面消息；
 * 注销后不再投递；重复注销安全；主视图与附加视图同一只时去重。
 */
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../../../shared/protocol.js';
import { createViewBroadcaster } from '../viewBroadcaster.js';

/** 造一个最小 Webview 替身：只实现广播器用到的 postMessage */
function fakeWebview(): { webview: vscode.Webview; posted: ExtensionToWebviewMessage[] } {
  const posted: ExtensionToWebviewMessage[] = [];
  const webview = {
    postMessage: vi.fn(async (msg: ExtensionToWebviewMessage) => {
      posted.push(msg);
      return true;
    }),
  } as unknown as vscode.Webview;
  return { webview, posted };
}

const PING: ExtensionToWebviewMessage = { type: 'notice', level: 'info', message: 'ping' };
const PROCESS: ExtensionToWebviewMessage = { type: 'step_boundary' };
const ACTIVITY: ExtensionToWebviewMessage = {
  type: 'session_activity',
  runningIds: [],
  pendingIds: [],
  badgeCount: 0,
};

describe('viewBroadcaster', () => {
  it('无视图时 post / postRaw 都是空操作', () => {
    const bc = createViewBroadcaster();
    expect(bc.size()).toBe(0);
    expect(() => bc.post(PING, undefined)).not.toThrow();
    expect(() => bc.postRaw(ACTIVITY, undefined)).not.toThrow();
  });

  it('仅主视图：会话级消息目标 = 主视图会话时投给 primary（侧栏零回归）', () => {
    const bc = createViewBroadcaster();
    const primary = fakeWebview();
    bc.post(PING, primary.webview, { sessionId: 'A', primarySessionId: 'A' });
    expect(primary.posted).toEqual([PING]);
    expect(bc.size()).toBe(0); // 主视图不进附加集合
  });

  it('会话级消息目标 ≠ 主视图会话：primary 不收（切走后不串台）', () => {
    const bc = createViewBroadcaster();
    const primary = fakeWebview();
    bc.post(PING, primary.webview, { sessionId: 'A', primarySessionId: 'B' });
    expect(primary.posted).toEqual([]);
  });

  it('绑 A 的附加视图只收 A 的会话级消息，收不到 B 的', () => {
    const bc = createViewBroadcaster();
    const primary = fakeWebview();
    const assistant = fakeWebview();
    bc.register(assistant.webview, { sessionId: () => 'A', bubbleOnly: true });

    bc.post(PING, primary.webview, { sessionId: 'B', primarySessionId: 'B' });
    expect(assistant.posted).toEqual([]); // B 只到侧栏
    expect(primary.posted).toEqual([PING]);

    bc.post(PING, primary.webview, { sessionId: 'A', primarySessionId: 'B' });
    expect(assistant.posted).toEqual([PING]); // A 只到助手窗
    expect(primary.posted).toEqual([PING]); // 主视图仍只有 B 那条
  });

  it('两个视图绑同一会话：两条都收到（侧栏看助手会话时同屏两取景）', () => {
    const bc = createViewBroadcaster();
    const primary = fakeWebview();
    const assistant = fakeWebview();
    bc.register(assistant.webview, { sessionId: () => 'A', bubbleOnly: true });

    bc.post(PING, primary.webview, { sessionId: 'A', primarySessionId: 'A' });
    expect(primary.posted).toEqual([PING]);
    expect(assistant.posted).toEqual([PING]);
  });

  it('全局广播（不传目标 / postRaw）投给主视图与全部附加视图', () => {
    const bc = createViewBroadcaster();
    const primary = fakeWebview();
    const assistant = fakeWebview();
    bc.register(assistant.webview, { sessionId: () => 'A', bubbleOnly: true });

    bc.post(ACTIVITY, primary.webview);
    bc.postRaw(ACTIVITY, primary.webview);
    expect(primary.posted).toEqual([ACTIVITY, ACTIVITY]);
    expect(assistant.posted).toEqual([ACTIVITY, ACTIVITY]);
  });

  it('气泡取景：助手窗收不到过程面消息，侧栏照样收（过滤按视图，不按会话砍源头）', () => {
    const bc = createViewBroadcaster();
    const primary = fakeWebview();
    const assistant = fakeWebview();
    bc.register(assistant.webview, { sessionId: () => 'A', bubbleOnly: true });

    bc.post(PROCESS, primary.webview, { sessionId: 'A', primarySessionId: 'A' });
    expect(primary.posted).toEqual([PROCESS]);
    expect(assistant.posted).toEqual([]);

    // 非过程面消息两个视图都收
    bc.post(PING, primary.webview, { sessionId: 'A', primarySessionId: 'A' });
    expect(assistant.posted).toEqual([PING]);
  });

  it('hasSession 只看附加视图的绑定，且每次现读（绑定变化立即生效）', () => {
    let bound = 'A';
    const bc = createViewBroadcaster();
    const assistant = fakeWebview();
    bc.register(assistant.webview, { sessionId: () => bound, bubbleOnly: true });

    expect(bc.hasSession('A')).toBe(true);
    expect(bc.hasSession('B')).toBe(false);
    bound = 'B';
    expect(bc.hasSession('A')).toBe(false);
    expect(bc.hasSession('B')).toBe(true);
  });

  it('注销后不再向附加视图投递（防向已销毁 webview 发消息），重复注销安全', () => {
    const bc = createViewBroadcaster();
    const primary = fakeWebview();
    const assistant = fakeWebview();
    const unregister = bc.register(assistant.webview, {
      sessionId: () => 'A',
      bubbleOnly: true,
    });

    unregister.dispose();
    unregister.dispose();
    expect(bc.size()).toBe(0);
    bc.post(PING, primary.webview, { sessionId: 'A', primarySessionId: 'A' });
    expect(assistant.posted).toEqual([]);
    expect(primary.posted).toEqual([PING]);
  });

  it('主视图与附加视图为同一只时去重（只投一次，不重复渲染）', () => {
    const bc = createViewBroadcaster();
    const same = fakeWebview();
    bc.register(same.webview, { sessionId: () => 'A', bubbleOnly: false });
    const callsBefore = vi.mocked(same.webview.postMessage).mock.calls.length;

    bc.post(PING, same.webview, { sessionId: 'A', primarySessionId: 'A' });
    expect(vi.mocked(same.webview.postMessage).mock.calls.length - callsBefore).toBe(1);
  });
});
