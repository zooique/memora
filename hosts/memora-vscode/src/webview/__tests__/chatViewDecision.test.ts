/**
 * C2 决策记录 webview 渲染测试（方案 §6.6-C2：时间线第三类事件）
 *
 * 覆盖 kind:'decision' 的呈现形态：
 *   ① 决策记录入时间线并带 decision 行类（左侧竖线视觉区分的挂点）；
 *   ② 普通活动行**不**带 decision 类（反向：防「所有行都标决策」的泛滥变异）；
 *   ③ 超时拒（error 级）决策记录同样入线且双类并存（红显 + 决策竖线）。
 *
 * 宿主出口（裁决/超时发不发事件）归 chatPanelDecision.test.ts，本文件只管渲染。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

describe('C2 决策记录 webview 渲染（chatView · 方案 §6.6-C2）', () => {
  beforeEach(() => {
    mountChatView();
  });

  it('kind:decision notice → 时间线决策行（class 含 decision）', () => {
    dispatch({
      type: 'notice',
      level: 'info',
      message: '已批准 写文件：foo.md',
      kind: 'decision',
    });
    const row = document.querySelector('.activity-list__row.decision');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('已批准');
  });

  it('普通 notice 不带 decision 类（反向：不泛滥）', () => {
    dispatch({ type: 'notice', level: 'info', message: '已停止生成' });
    expect(document.querySelector('.activity-list__row.decision')).toBeNull();
    // 普通行本体仍正常入线
    expect(document.querySelector('.activity-list__row')).not.toBeNull();
  });

  it('超时拒决策记录（error）双类并存：红显 + 决策竖线', () => {
    dispatch({
      type: 'notice',
      level: 'error',
      message: '用户未在时限内确认，已自动拒绝（写文件：foo.md）',
      kind: 'decision',
    });
    const row = document.querySelector('.activity-list__row.decision.error');
    expect(row).not.toBeNull();
  });
});
