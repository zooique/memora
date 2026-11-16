/**
 * 多视图广播器单测（HOSTED-UI-SEAT-DECOUPLE-1 地基）
 *
 * 钉这些事：会话级 post 受后台闸约束（后台流丢弃）、全局信号 postRaw 绕过闸；
 * 扇出到主视图（侧栏，显式传）+ 附加视图（托管页），单附加视图为 0 时与旧单端等价；
 * 注销后不再向附加视图投递（防向已销毁 webview 发消息）；主视图与附加视图同一只时去重；
 * 附加视图数可断言（不含主视图）。
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
const ACTIVITY: ExtensionToWebviewMessage = {
  type: 'session_activity',
  runningIds: [],
  pendingIds: [],
  badgeCount: 0,
};

describe('viewBroadcaster', () => {
  it('无视图时 post / postRaw 都是空操作', () => {
    const bc = createViewBroadcaster(() => false);
    expect(bc.size()).toBe(0);
    expect(() => bc.post(PING, undefined)).not.toThrow();
    expect(() => bc.postRaw(ACTIVITY, undefined)).not.toThrow();
  });

  it('仅主视图：post 投给 primary（与旧单端行为等价，零回归）', () => {
    const bc = createViewBroadcaster(() => false);
    const primary = fakeWebview();
    bc.post(PING, primary.webview);
    expect(primary.posted).toEqual([PING]);
    expect(bc.size()).toBe(0); // 主视图不进附加集合
  });

  it('主 + 附加：post 扇出到侧栏与托管页两个视图', () => {
    const bc = createViewBroadcaster(() => false);
    const primary = fakeWebview();
    const extra = fakeWebview();
    bc.register(extra.webview);
    expect(bc.size()).toBe(1);

    bc.post(PING, primary.webview);
    expect(primary.posted).toEqual([PING]);
    expect(extra.posted).toEqual([PING]);
  });

  it('后台闸：background=true 时 post 丢弃（含主视图），但 postRaw 仍全投', () => {
    const bc = createViewBroadcaster(() => true);
    const primary = fakeWebview();
    const extra = fakeWebview();
    bc.register(extra.webview);

    bc.post(PING, primary.webview);
    expect(primary.posted).toEqual([]);
    expect(extra.posted).toEqual([]);

    bc.postRaw(ACTIVITY, primary.webview);
    expect(primary.posted).toEqual([ACTIVITY]);
    expect(extra.posted).toEqual([ACTIVITY]);
  });

  it('判据现场取值：background 翻转后同一广播器的 post 行为随之改变', () => {
    let background = false;
    const bc = createViewBroadcaster(() => background);
    const primary = fakeWebview();

    bc.post(PING, primary.webview);
    expect(primary.posted).toEqual([PING]);
    background = true;
    bc.post(PING, primary.webview);
    expect(primary.posted).toEqual([PING]); // 未新增 ⇒ 后台那次被丢弃
  });

  it('注销后不再向附加视图投递（防向已销毁 webview 发消息）', () => {
    const bc = createViewBroadcaster(() => false);
    const primary = fakeWebview();
    const extra = fakeWebview();
    const unregister = bc.register(extra.webview);

    unregister.dispose();
    expect(bc.size()).toBe(0);
    bc.post(PING, primary.webview);
    expect(extra.posted).toEqual([]);
    expect(primary.posted).toEqual([PING]);
  });

  it('主视图与附加视图为同一只时去重（只投一次，不重复渲染）', () => {
    const bc = createViewBroadcaster(() => false);
    const same = fakeWebview();
    bc.register(same.webview);
    const callsBefore = vi.mocked(same.webview.postMessage).mock.calls.length;

    bc.post(PING, same.webview);
    // 同一只 webview 只被 postMessage 一次
    expect(vi.mocked(same.webview.postMessage).mock.calls.length - callsBefore).toBe(1);
  });
});
