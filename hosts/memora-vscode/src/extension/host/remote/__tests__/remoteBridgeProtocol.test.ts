/**
 * 远程桥协议单测 —— 封套白名单 / 上行帧解析 / 下行序列化
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §6.1（字段）、§6.5（23 条封套）、§6.6（命令九条）
 */
import { describe, expect, it } from 'vitest';
import { REMOTE_COMMANDS } from '../remoteCommandPolicy.js';
import {
  BRIDGE_ENVELOPE_TYPES,
  buildAppendTextDeltaFrame,
  buildConfirmAttentionFrame,
  buildProcessEventDeltaFrame,
  buildResetRequiredFrame,
  buildResumeOkFrame,
  buildRoleListOkFrame,
  buildSessionCreatedFrame,
  buildStatusDeltaFrame,
  buildSnapshotFrame,
  DEFAULT_REMOTE_CAPS,
  hasProcessEventsCap,
  parseBridgeFrame,
  REMOTE_CAP_PROCESS_EVENTS,
  REMOTE_CAP_ROLE_LIST,
  serializeBridgeFrame,
  type SnapshotPayload,
} from '../remoteBridgeProtocol.js';

describe('remoteBridgeProtocol — 封套类型（23 条）', () => {
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
      'session_create',
      'session_created',
      'role_list',
      'role_list_ok',
    ]);
    expect(BRIDGE_ENVELOPE_TYPES).toHaveLength(23);
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

  it('session_create：rid 必填（回执定址凭据）；title / role 可省，空串按未给', () => {
    const ok = parseBridgeFrame(JSON.stringify({ t: 'session_create', rid: 'c-1' }));
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.frame.t === 'session_create') {
      expect(ok.frame.rid).toBe('c-1');
      // 空串不落进合法帧（宿主按「未给标题」回落到默认标题）
      expect(ok.frame.title).toBeUndefined();
      expect(ok.frame.role).toBeUndefined();
    }
    const trimmed = parseBridgeFrame(
      JSON.stringify({
        t: 'session_create',
        rid: 'c-2',
        title: '  整理周报  ',
        role: ' 共鸣小说家 ',
      }),
    );
    if (trimmed.ok && trimmed.frame.t === 'session_create') {
      expect(trimmed.frame.title).toBe('整理周报');
      // 角色名只归一不改写；存在性校验归宿主的目录编目（桥不自造第二份判据）
      expect(trimmed.frame.role).toBe('共鸣小说家');
    }
    // 空串角色名 = 未指定（宿主走「默认 → 兜底包」链）
    const blankRole = parseBridgeFrame(
      JSON.stringify({ t: 'session_create', rid: 'c-4', role: '   ' }),
    );
    if (blankRole.ok && blankRole.frame.t === 'session_create') {
      expect(blankRole.frame.role).toBeUndefined();
    }
    // rid 缺失 = 拒绝（不然手机不知道回执对应哪次点击）
    expect(parseBridgeFrame(JSON.stringify({ t: 'session_create' })).ok).toBe(false);
    // title / role 非字符串 = 拒绝
    expect(parseBridgeFrame(JSON.stringify({ t: 'session_create', rid: 'c-3', title: 1 })).ok).toBe(
      false,
    );
    expect(parseBridgeFrame(JSON.stringify({ t: 'session_create', rid: 'c-5', role: 1 })).ok).toBe(
      false,
    );
  });

  it('role_list：跨会话只读帧，rid 可省并原样保留', () => {
    const bare = parseBridgeFrame(JSON.stringify({ t: 'role_list' }));
    expect(bare.ok).toBe(true);
    if (bare.ok && bare.frame.t === 'role_list') expect(bare.frame.rid).toBeUndefined();
    const withRid = parseBridgeFrame(JSON.stringify({ t: 'role_list', rid: 'rl-1' }));
    if (withRid.ok && withRid.frame.t === 'role_list') expect(withRid.frame.rid).toBe('rl-1');
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

  it('session_created：rid / sid / title 逐字下发；空 rid / sid 构造即抛', () => {
    const frame = JSON.parse(
      serializeBridgeFrame(buildSessionCreatedFrame('c-1', '2026-11-28-sabc', '新会话')),
    ) as Record<string, unknown>;
    // 独立手写期望：身份（sid）必须由宿主在回执里显式给出，不许手机反推
    expect(frame).toEqual({
      t: 'session_created',
      ch: 'ctl',
      rid: 'c-1',
      sid: '2026-11-28-sabc',
      title: '新会话',
    });
    expect(() => buildSessionCreatedFrame('', 's', 't')).toThrow();
    expect(() => buildSessionCreatedFrame('c', '', 't')).toThrow();
    // 角色名只在宿主真的有值时回带（未指定 / 校验失效不落空串）
    const withRole = JSON.parse(
      serializeBridgeFrame(buildSessionCreatedFrame('c-2', 's-2', '新会话', '共鸣小说家')),
    ) as Record<string, unknown>;
    expect(withRole.role).toBe('共鸣小说家');
    const bare = JSON.parse(
      serializeBridgeFrame(buildSessionCreatedFrame('c-3', 's-3', '新会话')),
    ) as Record<string, unknown>;
    expect(bare).not.toHaveProperty('role');
  });

  it('role_list_ok：packs / defaultName / rid 按需下发（缺省字段不落空串）', () => {
    const frame = JSON.parse(
      serializeBridgeFrame(
        buildRoleListOkFrame(
          [{ name: '共鸣小说家', displayName: '共鸣小说家', description: '写小说' }],
          '共鸣小说家',
          'rl-1',
        ),
      ),
    ) as Record<string, unknown>;
    expect(frame).toEqual({
      t: 'role_list_ok',
      ch: 'ctl',
      rid: 'rl-1',
      packs: [{ name: '共鸣小说家', displayName: '共鸣小说家', description: '写小说' }],
      defaultName: '共鸣小说家',
    });
    // 未设默认包 / 未带 rid：两个键都不出现（不拿空串冒充事实）
    const bare = JSON.parse(serializeBridgeFrame(buildRoleListOkFrame([], undefined))) as Record<
      string,
      unknown
    >;
    expect(bare).not.toHaveProperty('rid');
    expect(bare).not.toHaveProperty('defaultName');
    expect(bare.packs).toEqual([]);
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

  it('append_text delta 逐字段对齐 §6.4.1；空 roundId / text / 非法 seq 即抛', () => {
    const frame = JSON.parse(
      serializeBridgeFrame(buildAppendTextDeltaFrame('s-1', 4, 'r-9', '新增正文')),
    ) as Record<string, unknown>;
    // 独立手写期望：字段漂移（尤其把后缀换成整段、roundId 拍平）必须红
    expect(frame).toEqual({
      t: 'evt',
      ch: 'events',
      sid: 's-1',
      seq: 4,
      kind: 'delta',
      p: { kind: 'append_text', roundId: 'r-9', text: '新增正文' },
    });
    expect(() => buildAppendTextDeltaFrame('s-1', 4, '', 'x')).toThrow();
    expect(() => buildAppendTextDeltaFrame('s-1', 4, 'r-9', '')).toThrow();
    expect(() => buildAppendTextDeltaFrame('s-1', 0, 'r-9', 'x')).toThrow();
    expect(() => buildAppendTextDeltaFrame('', 4, 'r-9', 'x')).toThrow();
  });

  it('process_event delta 逐字透传内核 ProcessEvent 判别联合，不猜字段', () => {
    const event = {
      type: 'tool_start',
      seq: 12,
      ts: '2026-11-27T00:00:00.000Z',
      payload: { toolCallId: 'call-1', name: 'write_file' },
    } as const;
    const frame = JSON.parse(
      serializeBridgeFrame(buildProcessEventDeltaFrame('s-1', 5, 'r-9', event)),
    ) as Record<string, unknown>;
    // 全等断言：任何字段裁剪 / 重命名 / 拍平都要红
    expect(frame).toEqual({
      t: 'evt',
      ch: 'events',
      sid: 's-1',
      seq: 5,
      kind: 'delta',
      p: { kind: 'process_event', roundId: 'r-9', event },
    });
    expect(() => buildProcessEventDeltaFrame('s-1', 5, '', event)).toThrow();
    expect(() => buildProcessEventDeltaFrame('s-1', 5, 'r-9', event)).not.toThrow();
  });

  it('reset_required 唯一构造点：sid 必带，空 sid 即抛', () => {
    const frame = JSON.parse(serializeBridgeFrame(buildResetRequiredFrame('s-1'))) as Record<
      string,
      unknown
    >;
    expect(frame).toEqual({ t: 'reset_required', ch: 'ctl', sid: 's-1' });
    expect(() => buildResetRequiredFrame('')).toThrow();
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

  it('§6.8 caps 词表唯一：默认含 process_events；关闭时快照整键删明细', () => {
    expect(REMOTE_CAP_PROCESS_EVENTS).toBe('process_events');
    expect(REMOTE_CAP_ROLE_LIST).toBe('role_list');
    // 取值域只列手机真实消费的能力：新增条目必须同时有手机侧消费点
    expect(DEFAULT_REMOTE_CAPS).toEqual(['process_events', 'role_list']);
    expect(hasProcessEventsCap(undefined)).toBe(true);
    expect(hasProcessEventsCap([])).toBe(false);
    const snapshot = {
      state: { phase: 'idle' },
      rounds: [{ id: 'r1', processEvents: [{ seq: 1 }] }],
      pendingQueue: [],
    } as unknown as SnapshotPayload;
    const full = JSON.parse(serializeBridgeFrame(buildSnapshotFrame('s', snapshot))) as {
      p: { rounds: Array<Record<string, unknown>> };
    };
    expect(full.p.rounds[0]!.processEvents).toEqual([{ seq: 1 }]);
    const degraded = JSON.parse(
      serializeBridgeFrame(buildSnapshotFrame('s', snapshot, { includeProcessEvents: false })),
    ) as { p: { rounds: Array<Record<string, unknown>> } };
    expect('processEvents' in degraded.p.rounds[0]!).toBe(false);
  });
});
