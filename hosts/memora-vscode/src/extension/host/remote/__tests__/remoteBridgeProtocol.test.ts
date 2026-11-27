/**
 * 远程桥协议单测 —— 封套白名单 / 上行帧解析 / 下行序列化
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §6.1（字段）、§6.5（19 条封套）、§6.6（命令九条）
 */
import { describe, expect, it } from 'vitest';
import { REMOTE_COMMANDS } from '../remoteCommandPolicy.js';
import {
  BRIDGE_ENVELOPE_TYPES,
  buildConfirmAttentionFrame,
  buildResumeOkFrame,
  buildStatusDeltaFrame,
  parseBridgeFrame,
  serializeBridgeFrame,
} from '../remoteBridgeProtocol.js';

describe('remoteBridgeProtocol — 封套类型（19 条）', () => {
  it('清单与方案 §6.5 逐条一致（不多不少、顺序稳定）', () => {
    expect([...BRIDGE_ENVELOPE_TYPES]).toEqual([
      'hello',
      'hello_ok',
      'resume',
      'resume_ok',
      'reset_required',
      'host_state',
      'ping',
      'pong',
      'ack',
      'err',
      'sub',
      'unsub',
      'evt',
      'cmd',
      'attention',
      'blob_get',
      'blob_data',
      'session_list',
      'session_list_ok',
    ]);
    expect(BRIDGE_ENVELOPE_TYPES).toHaveLength(19);
  });
});

describe('remoteBridgeProtocol — 上行帧解析', () => {
  it('hello 合法帧通过（回环档不带 mode / pid）', () => {
    const result = parseBridgeFrame(
      JSON.stringify({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame.t).toBe('hello');
  });

  it('hello 缺字段 / 版本不符一律拒绝', () => {
    expect(
      parseBridgeFrame(
        JSON.stringify({ t: 'hello', v: 2, deviceId: 'd', nonce: 'n', phoneFp: 'f' }),
      ).ok,
    ).toBe(false);
    expect(
      parseBridgeFrame(JSON.stringify({ t: 'hello', v: 1, nonce: 'n', phoneFp: 'f' })).ok,
    ).toBe(false);
    expect(
      parseBridgeFrame(JSON.stringify({ t: 'hello', v: 1, deviceId: '', nonce: 'n', phoneFp: 'f' }))
        .ok,
    ).toBe(false);
  });

  it('ping 无载荷', () => {
    expect(parseBridgeFrame('{"t":"ping"}').ok).toBe(true);
  });

  it('sub / unsub 必须带非空 sid', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'sub', sid: 's1' })).ok).toBe(true);
    expect(parseBridgeFrame(JSON.stringify({ t: 'sub' })).ok).toBe(false);
    expect(parseBridgeFrame(JSON.stringify({ t: 'unsub', sid: '' })).ok).toBe(false);
  });

  it('ack 必须带 ch 与非负整数 seq', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'ack', ch: 'events', seq: 3 })).ok).toBe(true);
    expect(parseBridgeFrame(JSON.stringify({ t: 'ack', ch: 'events', seq: -1 })).ok).toBe(false);
    expect(parseBridgeFrame(JSON.stringify({ t: 'ack', seq: 1 })).ok).toBe(false);
  });

  it('resume 必须带两个水位数字', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'resume', upSeq: 1, recvSeq: 1 })).ok).toBe(true);
    expect(parseBridgeFrame(JSON.stringify({ t: 'resume', upSeq: 1 })).ok).toBe(false);
  });

  it('cmd：ch 必须为 cmd、rid / sid 必填、kind 必须落在真值表九条内', () => {
    const base = { t: 'cmd', ch: 'cmd', rid: 'u-1', sid: 's1' };
    for (const kind of REMOTE_COMMANDS) {
      expect(parseBridgeFrame(JSON.stringify({ ...base, kind })).ok).toBe(true);
    }
    expect(parseBridgeFrame(JSON.stringify({ ...base, kind: 'answer', ch: 'events' })).ok).toBe(
      false,
    );
    expect(parseBridgeFrame(JSON.stringify({ ...base, kind: 'unknown' })).ok).toBe(false);
    expect(
      parseBridgeFrame(JSON.stringify({ t: 'cmd', ch: 'cmd', sid: 's1', kind: 'answer' })).ok,
    ).toBe(false);
  });

  it('session_list 不带 sid（跨会话帧）', () => {
    expect(parseBridgeFrame('{"t":"session_list"}').ok).toBe(true);
  });

  it('未知 t / 下行专用 t / 非 JSON 一律拒绝', () => {
    expect(parseBridgeFrame('{"t":"whatever"}').ok).toBe(false);
    expect(parseBridgeFrame('{"t":"evt","sid":"s"}').ok).toBe(false);
    expect(parseBridgeFrame('not-json').ok).toBe(false);
    expect(parseBridgeFrame('[1,2]').ok).toBe(false);
  });
});

describe('remoteBridgeProtocol — 下行序列化', () => {
  it('hello_ok 的 assistantSid 缺省时不进 JSON（不给手机发 null）', () => {
    const raw = serializeBridgeFrame({
      t: 'hello_ok',
      ch: 'ctl',
      serverTime: 1,
      pcId: 'pc',
      caps: ['observe'],
      limits: { maxFrame: 1024, credit: 0 },
    });
    expect(JSON.parse(raw)).not.toHaveProperty('assistantSid');
  });

  it('attention confirm 带 requestId 定址、label 可选；空 sid / requestId 构造即抛', () => {
    const frame = JSON.parse(
      serializeBridgeFrame(buildConfirmAttentionFrame('s-1', 'req-7', 'write_file：a.txt')),
    ) as Record<string, unknown>;
    // 独立手写期望（不复用实现的字段名常量）
    expect(frame).toEqual({
      t: 'attention',
      ch: 'events',
      sid: 's-1',
      kind: 'confirm',
      requestId: 'req-7',
      label: 'write_file：a.txt',
    });
    const noLabel = JSON.parse(
      serializeBridgeFrame(buildConfirmAttentionFrame('s-1', 'req-7')),
    ) as Record<string, unknown>;
    expect(noLabel).not.toHaveProperty('label');
    expect(() => buildConfirmAttentionFrame('', 'req-7')).toThrow();
    expect(() => buildConfirmAttentionFrame('s-1', '')).toThrow();
  });

  it('status delta 从 seq=1 起，载荷只带 status 与原始 state 对象', () => {
    const state = { phase: 'waiting', reason: 'ask' } as const;
    const frame = JSON.parse(
      serializeBridgeFrame(buildStatusDeltaFrame('s-1', 3, state)),
    ) as Record<string, unknown>;
    // 独立手写期望：字段漂移（尤其把 state 拍平成字符串）必须红
    expect(frame).toEqual({
      t: 'evt',
      ch: 'events',
      sid: 's-1',
      seq: 3,
      kind: 'delta',
      p: { kind: 'status', state },
    });
    expect(() => buildStatusDeltaFrame('s-1', 0, state)).toThrow();
    expect(() => buildStatusDeltaFrame('', 1, state)).toThrow();
  });

  it('resume_ok 按 recvSeq+1 → sentSeq 回放；空回放合法，倒挂与零起点构造即抛', () => {
    const replay = JSON.parse(serializeBridgeFrame(buildResumeOkFrame('s-1', 3, 7))) as Record<
      string,
      unknown
    >;
    expect(replay).toEqual({ t: 'resume_ok', ch: 'ctl', sid: 's-1', fromSeq: 3, headSeq: 7 });
    const aligned = JSON.parse(serializeBridgeFrame(buildResumeOkFrame('s-1', 8, 7))) as Record<
      string,
      unknown
    >;
    expect(aligned).toMatchObject({ fromSeq: 8, headSeq: 7 });
    expect(() => buildResumeOkFrame('s-1', 0, 7)).toThrow();
    expect(() => buildResumeOkFrame('s-1', 9, 7)).toThrow();
    expect(() => buildResumeOkFrame('', 1, 7)).toThrow();
  });
});
