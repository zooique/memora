/**
 * 远程桥端到端单测 —— 真 `ws` 客户端连 `127.0.0.1`，验证 profile 2 的四条链路
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §19.3 profile 2
 *   （本地客户端跑通 hello / session_list / evt / cmd；端口占用显式报错）
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { RoundView, TurnState } from '../../../../shared/protocol.js';
import {
  RemoteBridge,
  type RemoteBridgePorts,
  type RemoteBridgeSecurity,
} from '../remoteBridge.js';
import type { RemoteDeviceTier } from '../remoteDevices.js';
import type { PairingVerdict } from '../remotePairing.js';
import type { RemoteInputMessage } from '../remoteCommandRouter.js';
import type { RemotePhase } from '../remoteCommandPolicy.js';
import { TRIMMED_RECENT_EVENTS, TRIMMED_RECENT_LOG } from '../remoteSnapshotTrim.js';
import { DEFAULT_REMOTE_CAPS, REMOTE_CAP_PROCESS_EVENTS } from '../remoteBridgeProtocol.js';

/** 单帧等待上限（防用例挂死；正常应远小于它） */
const FRAME_TIMEOUT = 2000;

/**
 * 测试用 WS 客户端：按到达顺序消费下行帧
 */
class TestClient {
  private readonly inbox: unknown[] = [];
  private readonly waiters: Array<(frame: unknown) => void> = [];
  /** 连接是否已关闭（LAN 档拒绝后必须断开） */
  private closedFlag = false;
  /** 等待关闭的回调（close 事件只触发一次） */
  private readonly closeWaiters: Array<() => void> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const frame: unknown = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.inbox.push(frame);
    });
    ws.on('close', () => {
      this.closedFlag = true;
      for (const waiter of this.closeWaiters.splice(0)) waiter();
    });
  }

  /** 建立连接（等 open 事件，避免用例在握手中途发帧） */
  static connect(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new TestClient(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  /** 发一帧 */
  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** 取下一帧（超时即失败，避免 await 永久挂起） */
  next<T = Record<string, unknown>>(): Promise<T> {
    const queued = this.inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('frame timeout')), FRAME_TIMEOUT);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame as T);
      });
    });
  }

  close(): void {
    this.ws.close();
  }

  /** 等待连接关闭（拒绝路径必须断开；超时即失败） */
  waitClosed(): Promise<void> {
    if (this.closedFlag) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('close timeout')), FRAME_TIMEOUT);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** 一个会话的假投影素材（`attachmentUris` 用来验证出桥前被剥掉） */
const ROUNDS: readonly RoundView[] = [
  { id: 'r1', attachmentUris: ['vscode-webview://x.png'] } as unknown as RoundView,
];

/** 构造一个 live 轮（正文可增长，供流中富增量用例消费） */
function makeLiveRound(text: string, events: readonly unknown[] = []): RoundView {
  return {
    id: 'r1',
    live: true,
    userMessage: { role: 'user', content: '问', timestamp: '2026-11-27T00:00:00.000Z' },
    assistantMessage: {
      id: 'm1',
      role: 'assistant',
      content: text,
      timestamp: '2026-11-27T00:00:00.000Z',
    },
    processEvents: events,
  } as unknown as RoundView;
}

const IDLE: TurnState = { phase: 'idle' };
const WAITING_ASK: TurnState = { phase: 'waiting', reason: 'ask' };

/**
 * 构造假 ports（默认：一个会话 s1、waiting-ask；投递记录进 `delivered`）
 */
function makePorts(overrides: Partial<RemoteBridgePorts> = {}): {
  ports: RemoteBridgePorts;
  delivered: Array<{ sid: string; input: RemoteInputMessage }>;
} {
  const delivered: Array<{ sid: string; input: RemoteInputMessage }> = [];
  const state: TurnState = WAITING_ASK;
  const ports: RemoteBridgePorts = {
    listSessions: () => ({
      sessions: [{ sessionId: 's1', title: '会话一', updatedAt: '2026-11-26T00:00:00Z' }],
      archivedIds: [],
      assistantSid: 'assist-1',
    }),
    hasSession: (sid) => sid === 's1',
    // 默认无角色包（本文件用例只验透传；角色列表用例在 overrides 里给）
    listRolePacks: () => ({ packs: [] }),
    phaseOf: () => (state.phase === 'waiting' ? 'waiting-ask' : 'idle'),
    snapshot: () => ({ state, rounds: ROUNDS, pendingQueue: [] }),
    deliverInput: (sid, input) => delivered.push({ sid, input }),
    answerConfirm: () => true,
    // 默认无在途审批；需要「订阅补发」的用例在 overrides 里给
    pendingConfirm: () => ({ count: 0 }),
    // 默认新建失败（本文件用例不建会话；建会话用例在 overrides 里给成功桩）
    createSession: async () => ({ ok: false as const }),
    ...overrides,
  };
  return { ports, delivered };
}

/** 起一个桥并连一个客户端（用例结束统一 close，避免句柄泄漏） */
const opened: Array<{ bridge: RemoteBridge; client?: TestClient }> = [];

async function startBridge(
  ports: RemoteBridgePorts,
  security?: RemoteBridgeSecurity,
  caps?: readonly string[],
): Promise<{ bridge: RemoteBridge; port: number }> {
  const bridge = new RemoteBridge(ports, { pcId: 'pc-test', security, caps });
  const { port } = await bridge.start();
  opened.push({ bridge });
  return { bridge, port };
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    entry.client?.close();
    await entry.bridge.stop();
  }
});

describe('RemoteBridge — 握手与会话列表', () => {
  it('hello → hello_ok 带 pcId / caps / assistantSid；session_list → session_list_ok', async () => {
    const { ports } = makePorts();
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);

    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    const helloOk = await client.next<{
      t: string;
      pcId: string;
      assistantSid?: string;
      caps: string[];
    }>();
    expect(helloOk.t).toBe('hello_ok');
    expect(helloOk.pcId).toBe('pc-test');
    expect(helloOk.assistantSid).toBe('assist-1');
    // §6.8 默认下发：旧的错误词表（observe / answer）不得再出现在 caps 里
    expect(helloOk.caps).toEqual(DEFAULT_REMOTE_CAPS);
    expect(helloOk.caps).toContain(REMOTE_CAP_PROCESS_EVENTS);
    expect(helloOk.caps).not.toContain('observe');
    expect(helloOk.caps).not.toContain('answer');

    client.send({ t: 'session_list' });
    const list = await client.next<{ t: string; sessions: Array<{ sessionId: string }> }>();
    expect(list.t).toBe('session_list_ok');
    expect(list.sessions.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('握手前发业务帧 → err forbidden（ctl）', async () => {
    const { ports } = makePorts();
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);

    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-1',
      sid: 's1',
      kind: 'answer',
      p: { answers: ['a'] },
    });
    const err = await client.next<{ t: string; code: string; ch: string }>();
    expect(err.t).toBe('err');
    expect(err.code).toBe('forbidden');
    expect(err.ch).toBe('ctl');
  });
});

describe('RemoteBridge — 订阅与快照', () => {
  it('sub 命中 → evt snapshot（seq=0 且 rounds 已剥掉 attachmentUris）', async () => {
    const { ports } = makePorts();
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();

    client.send({ t: 'sub', sid: 's1' });
    const evt = await client.next<{
      t: string;
      sid: string;
      seq: number;
      kind: string;
      p: { state: TurnState; rounds: Array<Record<string, unknown>> };
    }>();
    expect(evt.t).toBe('evt');
    expect(evt.sid).toBe('s1');
    expect(evt.seq).toBe(0);
    expect(evt.kind).toBe('snapshot');
    expect(evt.p.state).toEqual(WAITING_ASK);
    expect(evt.p.rounds[0]).not.toHaveProperty('attachmentUris');
  });

  it('sub 时该会话有在途审批 → 快照后补发一张 attention（手机后开也能批）', async () => {
    const { ports } = makePorts({
      phaseOf: () => 'confirm-pending',
      pendingConfirm: (sid) =>
        sid === 's1' ? { count: 1, requestId: 'req-9', label: 'run_command：rm' } : { count: 0 },
    });
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();

    client.send({ t: 'sub', sid: 's1' });
    // 第一帧仍是快照（顺序不能反：attention 先到会让手机在没有轮次的情况下先弹卡）
    const snapshot = await client.next<{ kind: string }>();
    expect(snapshot.kind).toBe('snapshot');
    const attention = await client.next<{
      t: string;
      kind: string;
      sid: string;
      requestId: string;
      label?: string;
    }>();
    expect(attention.t).toBe('attention');
    expect(attention.kind).toBe('confirm');
    expect(attention.sid).toBe('s1');
    expect(attention.requestId).toBe('req-9');
    expect(attention.label).toBe('run_command：rm');
  });

  it('sub 快照的 rounds 走 TrimmedRound：过程事件与前序回答只留最近 N 条', async () => {
    // 超限一轮：过程事件 60 条、前序回答 30 段（上限见 remoteSnapshotTrim 的单一常量）
    const longRound = {
      id: 'r-long',
      status: 'complete',
      createdAt: 't1',
      processEvents: Array.from({ length: TRIMMED_RECENT_EVENTS + 10 }, (_, i) => ({
        type: `e${i}`,
      })),
      assistantLog: Array.from({ length: TRIMMED_RECENT_LOG + 10 }, (_, i) => ({
        id: `a${i}`,
        role: 'assistant',
        content: `段${i}`,
        timestamp: `t${i}`,
      })),
    } as unknown as RoundView;
    const { ports } = makePorts({
      snapshot: () => ({ state: WAITING_ASK, rounds: [longRound], pendingQueue: [] }),
    });
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();

    client.send({ t: 'sub', sid: 's1' });
    const evt = await client.next<{
      p: { rounds: Array<Record<string, unknown>> };
    }>();
    const round = evt.p.rounds[0]!;
    expect((round.processEvents as unknown[]).length).toBe(TRIMMED_RECENT_EVENTS);
    expect((round.assistantLog as unknown[]).length).toBe(TRIMMED_RECENT_LOG);
    expect(round.truncated).toEqual({ processEvents: 10, assistantLog: 10 });
    expect('attachmentUris' in round).toBe(false);
  });

  it('§6.8 降级态：caps 不含 process_events 时快照整键删明细，默认态不受影响', async () => {
    const round = {
      id: 'r-degraded',
      processEvents: [{ seq: 1 }],
      assistantLog: [{ id: 'a1', role: 'assistant', content: '段1', timestamp: 't1' }],
    } as unknown as RoundView;
    const { ports } = makePorts({
      snapshot: () => ({ state: WAITING_ASK, rounds: [round], pendingQueue: [] }),
    });
    const { port } = await startBridge(ports, undefined, []);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();
    client.send({ t: 'sub', sid: 's1' });
    const evt = await client.next<{ p: { rounds: Array<Record<string, unknown>> } }>();
    const out = evt.p.rounds[0]!;
    expect('processEvents' in out).toBe(false);
    // 其他裁剪口径不随能力门控漂移：附件仍剥、日志仍下发
    expect('attachmentUris' in out).toBe(false);
    expect(out.assistantLog).toBeDefined();
  });

  it('sub 不存在的会话 → err no_session；resume 只能回 reset_required', async () => {
    const { ports } = makePorts();
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();

    client.send({ t: 'sub', sid: 'missing' });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.code).toBe('no_session');

    client.send({ t: 'sub', sid: 's1' });
    await client.next();
    client.send({ t: 'resume', upSeq: 1, recvSeq: 0 });
    const reset = await client.next<{ t: string; sid: string }>();
    expect(reset.t).toBe('reset_required');
    expect(reset.sid).toBe('s1');
  });
});

describe('RemoteBridge — 宿主推送（订阅联动）', () => {
  it('订阅后 notifyTurnUpdate → 收到第二帧 evt snapshot', async () => {
    const { ports } = makePorts();
    const { bridge, port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();
    client.send({ t: 'sub', sid: 's1' });
    await client.next(); // 首帧快照

    bridge.notifyTurnUpdate('s1');
    const evt = await client.next<{ t: string; sid: string; seq: number; kind: string }>();
    expect(evt.t).toBe('evt');
    expect(evt.sid).toBe('s1');
    expect(evt.seq).toBe(0);
    expect(evt.kind).toBe('snapshot');
  });

  it('未订阅的会话不推送（下一帧仍是自己的请求应答）', async () => {
    const { ports } = makePorts();
    const { bridge, port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();

    bridge.notifyTurnUpdate('s1');
    client.send({ t: 'session_list' });
    const list = await client.next<{ t: string }>();
    // 若误推了 evt，这里先收到的会是 evt 而不是应答
    expect(list.t).toBe('session_list_ok');
  });

  it('未监听的桥收到通知不抛错（零开销）', () => {
    const bridge = new RemoteBridge(makePorts().ports, { pcId: 'pc-idle' });
    expect(() => bridge.notifyTurnUpdate('s1')).not.toThrow();
  });
});

describe('RemoteBridge — 命令（profile 2 只放行 answer）', () => {
  it('waiting-ask 下 answer 落到端口（位次与空串原样透传），并回推快照', async () => {
    const { ports, delivered } = makePorts();
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();
    client.send({ t: 'sub', sid: 's1' });
    await client.next();

    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-1',
      sid: 's1',
      kind: 'answer',
      p: { answers: ['第一问', '', '第三问'] },
    });
    const evt = await client.next<{ t: string; kind: string }>();
    expect(evt.t).toBe('evt');
    expect(evt.kind).toBe('snapshot');
    expect(delivered).toEqual([
      {
        sid: 's1',
        input: { type: 'input', kind: 'answer', answers: ['第一问', '', '第三问'] },
      },
    ]);
  });

  it('非 waiting-ask 下 answer → err stale_phase 且不投递', async () => {
    const { ports, delivered } = makePorts({
      phaseOf: () => 'idle',
      snapshot: () => ({ state: IDLE, rounds: [], pendingQueue: [] }),
    });
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();

    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-2',
      sid: 's1',
      kind: 'answer',
      p: { answers: ['a'] },
    });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.code).toBe('stale_phase');
    expect(delivered).toHaveLength(0);
  });

  it('answer 落到不存在的会话 → err no_session', async () => {
    const { ports, delivered } = makePorts();
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();

    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-3',
      sid: 'missing',
      kind: 'answer',
      p: { answers: ['a'] },
    });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.code).toBe('no_session');
    expect(delivered).toHaveLength(0);
  });

  it('只读 + 可答档：其余八条命令一律 err forbidden', async () => {
    const { ports, delivered } = makePorts();
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();

    for (const kind of [
      'send',
      'interject',
      'resume',
      'pause',
      'stop',
      'confirm_answer',
      'remove_pending_item',
      'clear_pending_queue',
    ]) {
      client.send({ t: 'cmd', ch: 'cmd', rid: `u-${kind}`, sid: 's1', kind, p: {} });
      const err = await client.next<{ t: string; code: string; ch: string }>();
      expect(err.code).toBe('forbidden');
      expect(err.ch).toBe('cmd');
    }
    expect(delivered).toHaveLength(0);
  });
});

describe('RemoteBridge — 监听失败显式报错', () => {
  it('端口已被占用时 start() 必须 reject，且不进入监听态', async () => {
    const first = makePorts();
    const { port } = await startBridge(first.ports);
    const second = new RemoteBridge(makePorts().ports, { pcId: 'pc-2', port });
    await expect(second.start()).rejects.toThrow();
    expect(second.listeningPort).toBeUndefined();
  });

  it('stop() 释放端口后同端口可再次监听', async () => {
    const { bridge, port } = await startBridge(makePorts().ports);
    await bridge.stop();
    expect(bridge.listeningPort).toBeUndefined();
    const again = new RemoteBridge(makePorts().ports, { pcId: 'pc-3', port });
    const started = await again.start();
    expect(started.port).toBe(port);
    await again.stop();
  });
});

// ─── profile 3：security 端口（配对 / 档位） ─────────────────────────────

/** 测试用设备指纹（64 位 hex，形态与真实证书 DER 指纹一致） */
const DEVICE_FP = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';

/**
 * 构造假 security（无需真 TLS；只验证桥的判据接线）
 *
 * 指纹固定为 `DEVICE_FP`；档位 / 口令结论 / 批准结果由用例指定。
 */
function makeSecurity(
  overrides: {
    tier?: RemoteDeviceTier;
    passcode?: PairingVerdict;
    approval?: boolean;
    blocked?: boolean;
  } = {},
): {
  security: RemoteBridgeSecurity;
  state: {
    registered: Array<{ fingerprint: string; shortFp: string; name: string }>;
    audits: Array<{ event: string; deviceFp?: string; ip?: string; detail?: string }>;
    successKeys: string[];
    failureKeys: string[];
  };
} {
  const state = {
    registered: [] as Array<{ fingerprint: string; shortFp: string; name: string }>,
    audits: [] as Array<{ event: string; deviceFp?: string; ip?: string; detail?: string }>,
    successKeys: [] as string[],
    failureKeys: [] as string[],
  };
  const security: RemoteBridgeSecurity = {
    fingerprintOf: () => DEVICE_FP,
    tierOf: () => overrides.tier,
    verifyPasscode: () => overrides.passcode ?? 'mismatch',
    requestApproval: async () => overrides.approval ?? false,
    registerDevice: (info) => state.registered.push(info),
    rateLimit: {
      check: () => ({ blocked: overrides.blocked ?? false, retryAfterMs: 0 }),
      noteFailure: (key) => {
        state.failureKeys.push(key);
        return { blocked: false, retryAfterMs: 0 };
      },
      noteSuccess: (key) => state.successKeys.push(key),
    },
    audit: (event) => {
      state.audits.push(event);
    },
  };
  return { security, state };
}

/**
 * 轮询等待某类审计事件落地
 *
 * 服务端的 ws `close` 事件在客户端 close 之后异步到达，不能假定同一 tick 内已记账。
 */
async function waitAudit(
  audits: Array<{ event: string }>,
  event: string,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!audits.some((e) => e.event === event)) {
    if (Date.now() - started > timeoutMs) throw new Error(`未等到审计事件 ${event}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 轮询等待某条件成立（用于无下行应答帧的副作用，如 unsub 后停表） */
async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('RemoteBridge — security 缺省（回环档行为不变）', () => {
  it('没有 security 时不校验 phoneFp（任意值都回 hello_ok）', async () => {
    const { ports } = makePorts();
    const { port } = await startBridge(ports);
    const client = await TestClient.connect(port);

    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: '这不是指纹' });
    const helloOk = await client.next<{ t: string }>();
    expect(helloOk.t).toBe('hello_ok');
  });
});

describe('RemoteBridge — LAN 档握手（security 存在）', () => {
  it('phoneFp 与 TLS 指纹不符 → err bad_passcode + 断开 + 审计', async () => {
    const { security, state } = makeSecurity({ tier: 'approve' });
    const { ports } = makePorts();
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);

    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'FFFF' });
    const err = await client.next<{ t: string; ch: string; code: string }>();
    expect(err.t).toBe('err');
    expect(err.ch).toBe('ctl');
    expect(err.code).toBe('bad_passcode');
    await client.waitClosed();
    expect(state.audits.some((e) => e.event === 'hello_fp_mismatch')).toBe(true);
  });

  it('未配对 + 错口令 → err bad_passcode、记录失败、断开', async () => {
    const { security, state } = makeSecurity({ passcode: 'mismatch' });
    const { ports } = makePorts();
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);

    client.send({
      t: 'hello',
      v: 1,
      deviceId: 'd1',
      nonce: 'n1',
      phoneFp: DEVICE_FP,
      pid: '00000000',
    });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.code).toBe('bad_passcode');
    await client.waitClosed();
    expect(state.failureKeys).toHaveLength(1);
    expect(state.registered).toHaveLength(0);
    expect(state.audits.some((e) => e.event === 'pairing_rejected')).toBe(true);
  });

  it('未配对 + 正确口令 + 人工批准 → 登记设备并回 hello_ok', async () => {
    const { security, state } = makeSecurity({ passcode: 'ok', approval: true });
    const { ports } = makePorts();
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);

    client.send({
      t: 'hello',
      v: 1,
      deviceId: '我的手机',
      nonce: 'n1',
      phoneFp: DEVICE_FP,
      pid: '00000042',
    });
    const helloOk = await client.next<{ t: string; pcId: string }>();
    expect(helloOk.t).toBe('hello_ok');
    expect(helloOk.pcId).toBe('pc-test');

    expect(state.registered).toEqual([
      { fingerprint: DEVICE_FP, shortFp: 'ABCD-EF01', name: '我的手机' },
    ]);
    expect(state.successKeys).toHaveLength(1);
    expect(state.audits.some((e) => e.event === 'device_paired')).toBe(true);
  });

  it('未配对 + 正确口令 + 拒绝批准 → err bad_passcode、记录失败、断开', async () => {
    const { security, state } = makeSecurity({ passcode: 'ok', approval: false });
    const { ports } = makePorts();
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);

    client.send({
      t: 'hello',
      v: 1,
      deviceId: 'd1',
      nonce: 'n1',
      phoneFp: DEVICE_FP,
      pid: '00000042',
    });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.code).toBe('bad_passcode');
    await client.waitClosed();
    expect(state.failureKeys).toHaveLength(1);
    expect(state.registered).toHaveLength(0);
    expect(state.audits.some((e) => e.event === 'pairing_denied')).toBe(true);
  });

  it('已配对（tierOf 有值）：无需口令直接 hello_ok，并审计 device_connected', async () => {
    const { security, state } = makeSecurity({ tier: 'observe' });
    const { ports } = makePorts();
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);

    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    const helloOk = await client.next<{ t: string }>();
    expect(helloOk.t).toBe('hello_ok');
    expect(state.audits.some((e) => e.event === 'device_connected')).toBe(true);

    // 断开也是安全事实：close 后应留一条 device_disconnected
    client.close();
    await waitAudit(state.audits, 'device_disconnected');
  });

  it('stop → 审计 bridge_stopped，且等异步审计落盘后才返回', async () => {
    const { security, state } = makeSecurity({ tier: 'observe' });
    // 异步审计模拟真实 fs append：stop() 必须等它完成（真机丢过 fire-and-forget 的行）
    security.audit = async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.audits.push(event);
    };
    const { ports } = makePorts();
    const { bridge } = await startBridge(ports, security);

    await bridge.stop();
    expect(state.audits.some((e) => e.event === 'bridge_stopped')).toBe(true);
  });
});

describe('RemoteBridge — LAN 档命令（设备权限档）', () => {
  it('observe 档发 answer → err forbidden，且不投递', async () => {
    const { security } = makeSecurity({ tier: 'observe' });
    const { ports, delivered } = makePorts();
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();

    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-1',
      sid: 's1',
      kind: 'answer',
      p: { answers: ['a'] },
    });
    const err = await client.next<{ t: string; ch: string; code: string }>();
    expect(err.t).toBe('err');
    expect(err.ch).toBe('cmd');
    expect(err.code).toBe('forbidden');
    expect(delivered).toHaveLength(0);
  });

  it('approve 档发 answer → 投递到宿主端口', async () => {
    const { security } = makeSecurity({ tier: 'approve' });
    const { ports, delivered } = makePorts();
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();
    // 先订阅：受理后桥会回推更新帧，用它作为「命令已处理」的确定性信号（不靠 sleep）
    client.send({ t: 'sub', sid: 's1' });
    await client.next();

    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-2',
      sid: 's1',
      kind: 'answer',
      p: { answers: ['好'] },
    });
    const evt = await client.next<{ t: string; kind: string }>();
    expect(evt.t).toBe('evt');
    // profile 3 的形状是 status 增量；回环档测试仍锁 snapshot，两档判据不混
    expect(evt.kind).toBe('delta');
    expect(delivered).toEqual([
      { sid: 's1', input: { type: 'input', kind: 'answer', answers: ['好'] } },
    ]);
  });

  it('send 档 + idle 发 send → 投递到 handleInput 并回推 status 增量', async () => {
    const { security } = makeSecurity({ tier: 'send' });
    const { ports, delivered } = makePorts({
      phaseOf: () => 'idle',
      snapshot: () => ({ state: IDLE, rounds: [], pendingQueue: [] }),
    });
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();
    client.send({ t: 'sub', sid: 's1' });
    await client.next();

    client.send({ t: 'cmd', ch: 'cmd', rid: 'u-6', sid: 's1', kind: 'send', p: { text: '你好' } });
    const evt = await client.next<{ t: string; kind: string }>();
    expect(evt.t).toBe('evt');
    expect(evt.kind).toBe('delta');
    expect(delivered).toEqual([
      { sid: 's1', input: { type: 'input', kind: 'send', text: '你好' } },
    ]);
  });

  it('send 档 + running 发 send → err busy（相位层面拒绝，不投递）', async () => {
    const { security } = makeSecurity({ tier: 'send' });
    const { ports, delivered } = makePorts({
      phaseOf: () => 'running',
      snapshot: () => ({
        state: { phase: 'running', roundId: 'r1' },
        rounds: [],
        pendingQueue: [],
      }),
    });
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();

    client.send({ t: 'cmd', ch: 'cmd', rid: 'u-7', sid: 's1', kind: 'send', p: { text: '继续' } });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.code).toBe('busy');
    expect(delivered).toHaveLength(0);
  });

  it('observe 档发 send → err forbidden（档位门先于载荷解析）', async () => {
    const { security } = makeSecurity({ tier: 'observe' });
    const { ports, delivered } = makePorts();
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();

    client.send({ t: 'cmd', ch: 'cmd', rid: 'u-8', sid: 's1', kind: 'send', p: { text: '你好' } });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.code).toBe('forbidden');
    expect(delivered).toHaveLength(0);
  });

  it('send 档：waiting-pause 发 resume 投递；idle 发 resume 回 already_resumed（幂等）', async () => {
    const { security } = makeSecurity({ tier: 'send' });
    const phase: { value: RemotePhase } = { value: 'waiting-pause' };
    const { ports, delivered } = makePorts({
      phaseOf: () => phase.value,
      snapshot: () => ({
        state: { phase: 'waiting', reason: 'pause' },
        rounds: [],
        pendingQueue: [],
      }),
    });
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();
    client.send({ t: 'sub', sid: 's1' });
    await client.next();

    client.send({ t: 'cmd', ch: 'cmd', rid: 'u-9', sid: 's1', kind: 'resume', p: {} });
    const evt = await client.next<{ t: string; kind: string }>();
    expect(evt.t).toBe('evt');
    expect(delivered).toEqual([{ sid: 's1', input: { type: 'input', kind: 'resume' } }]);

    // 已不在暂停态：重复解暂停按幂等成功处理（不投递第二条）
    phase.value = 'idle';
    client.send({ t: 'cmd', ch: 'cmd', rid: 'u-10', sid: 's1', kind: 'resume', p: {} });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.code).toBe('already_resumed');
    expect(delivered).toHaveLength(1);
  });

  it('pause 虽在档位表内，但本切片未接入 → forbidden 且零投递', async () => {
    const { security } = makeSecurity({ tier: 'approve' });
    const { ports, delivered } = makePorts({
      phaseOf: () => 'running',
      snapshot: () => ({ state: { phase: 'running' }, rounds: [], pendingQueue: [] }),
    });
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();

    client.send({ t: 'cmd', ch: 'cmd', rid: 'u-11', sid: 's1', kind: 'pause', p: {} });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.code).toBe('forbidden');
    expect(delivered).toHaveLength(0);
  });

  it('改档后同一连接的下一条 answer 生效（桥每次命令实时查 tierOf）', async () => {
    const { security } = makeSecurity({ tier: 'observe' });
    // 宿主设备表可变：模拟用户在本轮运行中把该设备从 observe 提到 approve
    let currentTier: RemoteDeviceTier | undefined = 'observe';
    security.tierOf = () => currentTier;
    const { ports, delivered } = makePorts();
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();

    // 改档前：observe 档发 answer → forbidden，不投递
    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-4',
      sid: 's1',
      kind: 'answer',
      p: { answers: ['a'] },
    });
    const forbidden = await client.next<{ t: string; code: string }>();
    expect(forbidden.code).toBe('forbidden');
    expect(delivered).toHaveLength(0);

    // 宿主改档（不重启桥、不断连接）
    currentTier = 'approve';

    // 用订阅快照作为建连锚点，再用受理后的增量帧作「已处理」信号
    client.send({ t: 'sub', sid: 's1' });
    await client.next();
    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-5',
      sid: 's1',
      kind: 'answer',
      p: { answers: ['改档后'] },
    });
    const evt = await client.next<{ t: string; kind: string }>();
    expect(evt.t).toBe('evt');
    expect(evt.kind).toBe('delta');
    expect(delivered).toEqual([
      { sid: 's1', input: { type: 'input', kind: 'answer', answers: ['改档后'] } },
    ]);
  });

  it('disconnectDevice 按已认证指纹断开连接（撤销后不再有读通道）', async () => {
    const { security } = makeSecurity({ tier: 'approve' });
    const { ports } = makePorts();
    const { bridge, port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();
    client.send({ t: 'sub', sid: 's1' });
    await client.next();

    // 撤销前：sub 已为该设备建了一条水位/回放窗条目（键 = 设备指纹 + 真 NUL + sid）
    const streams = (bridge as unknown as { streams: Map<string, unknown> }).streams;
    expect(streams.size).toBe(1);

    // 大小写不敏感：撤销入口传什么形态都应命中同一台设备
    const closed = bridge.disconnectDevice(DEVICE_FP.toLowerCase());
    expect(closed).toBe(1);
    // 回放窗必须随连接一起清掉（否则重连仍能补出已撤销设备的增量）。
    // 本条是对 `\\u0000`（字面反斜杠）写错前缀的回归护栏：写错时永不命中 ⇒ size 仍为 1 ⇒ 红。
    expect(streams.size).toBe(0);
    await client.waitClosed();
  });
});

describe('RemoteBridge — M3 审批闭环（attention 下行 + confirm_answer 上行）', () => {
  it('notifyAttention 按 sid 扇出 attention{requestId}；未订阅的会话收不到', async () => {
    const { ports, delivered: _delivered } = makePorts({
      phaseOf: () => 'confirm-pending',
    });
    void _delivered;
    const { bridge, port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();
    client.send({ t: 'sub', sid: 's1' });
    await client.next(); // 订阅回推的快照

    bridge.notifyAttention('s1', 'req-7', 'write_file：a.txt');
    const attn = await client.next<Record<string, unknown>>();
    expect(attn).toEqual({
      t: 'attention',
      ch: 'events',
      sid: 's1',
      kind: 'confirm',
      requestId: 'req-7',
      label: 'write_file：a.txt',
    });
    // 空 requestId = 无可裁决项：不发帧（防止「提醒了却批不了」）
    bridge.notifyAttention('s1', '');
    // 未订阅会话不扇出：发一帧后若误发会污染 inbox；用 next 超时反证代价高，
    // 这里只断言同一连接不会因别的 sid 多收一帧（判据由下行构造点单测覆盖）。
  });

  it('approve 档 confirm_answer → answerConfirm 收到 sid/id/approved，回推 status 增量', async () => {
    const { security } = makeSecurity({ tier: 'approve' });
    const calls: Array<[string, string, boolean]> = [];
    const { ports } = makePorts({
      phaseOf: () => 'confirm-pending',
      answerConfirm: (sid, requestId, approved) => {
        calls.push([sid, requestId, approved]);
        return true;
      },
    });
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();
    client.send({ t: 'sub', sid: 's1' });
    await client.next();

    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-m3',
      sid: 's1',
      kind: 'confirm_answer',
      p: { requestId: 'req-7', approved: false },
    });
    const evt = await client.next<{ t: string; kind: string; seq: number }>();
    // profile 3 已接增量：此处必须是带 seq 的 status delta，不再是 seq=0 快照
    expect(evt.t).toBe('evt');
    expect(evt.kind).toBe('delta');
    expect(evt.seq).toBe(1);
    expect(calls).toEqual([['s1', 'req-7', false]]);
  });

  it('confirm_answer 载荷写坏（缺 requestId / approved 非布尔）→ 断开连接', async () => {
    const { security } = makeSecurity({ tier: 'approve' });
    for (const p of [{ approved: true }, { requestId: 'req-7', approved: 'yes' }]) {
      const { ports } = makePorts({ phaseOf: () => 'confirm-pending' });
      const { port } = await startBridge(ports, security);
      const client = await TestClient.connect(port);
      client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
      await client.next();
      client.send({
        t: 'cmd',
        ch: 'cmd',
        rid: 'u-m3-bad',
        sid: 's1',
        kind: 'confirm_answer',
        p,
      });
      await client.waitClosed();
    }
  });

  it('answerConfirm=false（requestId 不匹配/迟到）→ err stale_phase', async () => {
    const { security } = makeSecurity({ tier: 'approve' });
    const { ports } = makePorts({
      phaseOf: () => 'confirm-pending',
      answerConfirm: () => false,
    });
    const { port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();
    client.send({
      t: 'cmd',
      ch: 'cmd',
      rid: 'u-m3-stale',
      sid: 's1',
      kind: 'confirm_answer',
      p: { requestId: 'req-old', approved: true },
    });
    const err = await client.next<{ t: string; code: string }>();
    expect(err.t).toBe('err');
    expect(err.code).toBe('stale_phase');
  });
});

describe('RemoteBridge — profile 3 delta 与水位补洞（§6.7 订正口径）', () => {
  /** 起 LAN 档桥、完成握手并订阅 s1（快照 seq 归零由 helper 自己消费） */
  async function openLanSub(
    ports: RemoteBridgePorts,
    security: RemoteBridgeSecurity,
    caps?: readonly string[],
  ): Promise<{ bridge: RemoteBridge; client: TestClient }> {
    const { bridge, port } = await startBridge(ports, security, caps);
    const client = await TestClient.connect(port);
    const entry = opened.find((item) => item.bridge === bridge);
    if (entry) entry.client = client;
    else opened.push({ bridge, client });
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();
    client.send({ t: 'sub', sid: 's1' });
    const snap = await client.next<{ t: string; kind: string; seq: number }>();
    expect(snap.t).toBe('evt');
    expect(snap.kind).toBe('snapshot');
    expect(snap.seq).toBe(0);
    return { bridge, client };
  }

  it('富增量端到端：订阅初始化游标 → 正文后缀与事件 seq 增量按水位顺序入窗', async () => {
    const ev = (seq: number, name: string) => ({
      type: 'tool_start',
      seq,
      ts: '2026-11-27T00:00:00.000Z',
      payload: { toolCallId: `c${seq}`, name },
    });
    const liveRound = (text: string, events: readonly unknown[]): RoundView =>
      ({
        id: 'r1',
        live: true,
        userMessage: { role: 'user', content: '问', timestamp: '2026-11-27T00:00:00.000Z' },
        assistantMessage: {
          id: 'm1',
          role: 'assistant',
          content: text,
          timestamp: '2026-11-27T00:00:00.000Z',
        },
        processEvents: events,
      }) as unknown as RoundView;
    const state: TurnState = { phase: 'running', roundId: 'r1' };

    let current = liveRound('你好', [ev(2, 'read_file')]);
    const { security } = makeSecurity({ tier: 'observe' });
    const { ports } = makePorts({
      snapshot: () => ({ state, rounds: [current], pendingQueue: [] }),
    });
    const { bridge, client } = await openLanSub(ports, security);
    // 订阅那刻的正文/事件已被 snapshot 覆盖，不得当增量重发

    current = liveRound('你好世界', [ev(2, 'read_file'), ev(5, 'write_file')]);
    bridge.notifyTurnUpdate('s1');
    const status = await client.next<{ t: string; kind: string; seq: number; p: unknown }>();
    expect(status).toMatchObject({ t: 'evt', kind: 'delta', sid: 's1', seq: 1 });
    expect(status.p).toEqual({ kind: 'status', state });
    const text = await client.next<{ seq: number; p: unknown }>();
    expect(text.seq).toBe(2);
    expect(text.p).toEqual({ kind: 'append_text', roundId: 'r1', text: '世界' });
    const process = await client.next<{ seq: number; p: unknown }>();
    expect(process.seq).toBe(3);
    expect(process.p).toEqual({ kind: 'process_event', roundId: 'r1', event: ev(5, 'write_file') });

    // 同一快照再触发：只有 status（seq=4），无富帧；用 ping 探底证明没有第 5 帧
    bridge.notifyTurnUpdate('s1');
    expect((await client.next<{ seq: number }>()).seq).toBe(4);
    client.send({ t: 'ping' });
    expect((await client.next<{ t: string }>()).t).toBe('pong');
  });

  it('§6.8 降级态：流中不发 process_event，resume 回放窗也无事件帧', async () => {
    const ev = (seq: number) => ({
      type: 'tool_start',
      seq,
      ts: '2026-11-27T00:00:00.000Z',
      payload: { toolCallId: `c${seq}`, name: 'read_file' },
    });
    const liveRound = (text: string, events: readonly unknown[]): RoundView =>
      ({
        id: 'r1',
        live: true,
        assistantMessage: { id: 'm1', role: 'assistant', content: text, timestamp: 't1' },
        processEvents: events,
      }) as unknown as RoundView;
    const state: TurnState = { phase: 'running', roundId: 'r1' };
    let current = liveRound('你好', [ev(2)]);
    const { security } = makeSecurity({ tier: 'observe' });
    const { ports } = makePorts({
      snapshot: () => ({ state, rounds: [current], pendingQueue: [] }),
    });
    const { bridge, client } = await openLanSub(ports, security, []);

    current = liveRound('你好世界', [ev(2), ev(5)]);
    bridge.notifyTurnUpdate('s1');
    expect(await client.next<{ seq: number }>()).toMatchObject({ seq: 1 });
    const text = await client.next<{ seq: number; p: unknown }>();
    expect(text).toMatchObject({ seq: 2 });
    expect(text.p).toEqual({ kind: 'append_text', roundId: 'r1', text: '世界' });
    // ping 探底：富增量里没有 process_event 帧
    client.send({ t: 'ping' });
    expect((await client.next<{ t: string }>()).t).toBe('pong');

    // 回放窗只缓存已发帧 ⇒ 补洞不会把明细带回来
    client.send({ t: 'resume', upSeq: 1, recvSeq: 0 });
    expect((await client.next<{ t: string }>()).t).toBe('resume_ok');
    const replayed = [await client.next<{ p: unknown }>(), await client.next<{ p: unknown }>()];
    expect(replayed.map((frame) => (frame.p as { kind: string }).kind)).toEqual([
      'status',
      'append_text',
    ]);
    client.send({ t: 'ping' });
    expect((await client.next<{ t: string }>()).t).toBe('pong');
  });

  it('收场补快照：落盘正文全量覆盖 + 水位归零（真机「漏445/错16」的机器判据）', async () => {
    // 落盘 Round.assistantMessage（无 live 标记）是内核已扣 withdrawn 的正文唯一真源：
    // 流中曾 append 的 16 字过渡叙述不得留在收口快照，最终正文必须整段到达手机。
    const settledRound = {
      id: 'r1',
      assistantMessage: {
        id: 'm1',
        role: 'assistant',
        content: '最终正文（内核已扣过渡叙述）',
        timestamp: '2026-11-27T00:00:00.000Z',
      },
    } as unknown as RoundView;
    const running: TurnState = { phase: 'running', roundId: 'r1' };
    const settled: TurnState = { phase: 'settled', roundId: 'r1', status: 'complete' };
    let current: TurnState = running;
    const { security } = makeSecurity({ tier: 'observe' });
    const { ports } = makePorts({
      phaseOf: () => (current.phase === 'running' ? 'running' : 'idle'),
      snapshot: () => ({ state: current, rounds: [settledRound], pendingQueue: [] }),
    });
    const { bridge, client } = await openLanSub(ports, security);

    // 流中普通通知：只有 status seq=1（快照里无 live 轮，富差分按设计零增量）
    bridge.notifyTurnUpdate('s1');
    expect((await client.next<{ seq: number }>()).seq).toBe(1);

    // 收场：宿主带 settled=true → 补一帧 seq=0 快照，落盘正文全量覆盖
    current = settled;
    bridge.notifyTurnUpdate('s1', true);
    const snap = await client.next<{
      seq: number;
      kind: string;
      p: { rounds: Array<{ assistantMessage?: { content: string } }> };
    }>();
    expect(snap).toMatchObject({ seq: 0, kind: 'snapshot' });
    expect(snap.p.rounds[0]?.assistantMessage?.content).toBe('最终正文（内核已扣过渡叙述）');
    expect(JSON.stringify(snap)).not.toContain('我先确认该文件是否在项目内可读。');
    // ping 探底：收场只补快照，不再发 status/富增量（避免 seq 谱系分叉）
    client.send({ t: 'ping' });
    expect((await client.next<{ t: string }>()).t).toBe('pong');

    // 水位归零实证：快照后第一帧增量从 seq=1 起（与手机「seq=0 快照归零重建」对齐）
    bridge.notifyTurnUpdate('s1');
    expect(await client.next<{ seq: number; kind: string }>()).toMatchObject({
      seq: 1,
      kind: 'delta',
    });
  });

  it('按设备独立递增 status 增量；resume 从 recvSeq+1 回放到 sentSeq', async () => {
    const { security } = makeSecurity({ tier: 'observe' });
    const { ports } = makePorts();
    const { bridge, client } = await openLanSub(ports, security);

    bridge.notifyTurnUpdate('s1');
    bridge.notifyTurnUpdate('s1');
    const d1 = await client.next<{ t: string; kind: string; seq: number; p: unknown }>();
    expect(d1).toMatchObject({ t: 'evt', kind: 'delta', sid: 's1', seq: 1 });
    expect(d1.p).toEqual({ kind: 'status', state: WAITING_ASK });
    const d2 = await client.next<{ seq: number }>();
    expect(d2.seq).toBe(2);

    client.send({ t: 'resume', upSeq: 1, recvSeq: 0, sid: 's1' });
    const ok = await client.next<{ t: string; fromSeq: number; headSeq: number }>();
    // 独立手写期望：若按方案旧稿写 sentSeq+1（=3），这里必须红
    expect(ok).toEqual({ t: 'resume_ok', ch: 'ctl', sid: 's1', fromSeq: 1, headSeq: 2 });
    const r1 = await client.next<{ seq: number }>();
    const r2 = await client.next<{ seq: number }>();
    expect([r1.seq, r2.seq]).toEqual([1, 2]);
  });

  it('recvSeq==sentSeq → 空回放 resume_ok，不发多余帧', async () => {
    const { security } = makeSecurity({ tier: 'observe' });
    const { bridge, client } = await openLanSub(makePorts().ports, security);
    bridge.notifyTurnUpdate('s1');
    const delta = await client.next<{ seq: number }>();
    expect(delta.seq).toBe(1);

    client.send({ t: 'resume', upSeq: 1, recvSeq: 1 });
    const ok = await client.next<{ fromSeq: number; headSeq: number }>();
    expect(ok).toMatchObject({ fromSeq: 2, headSeq: 1 });
    // 用 ping/pong 探帧：若误发回放帧，下一条不会是 pong
    client.send({ t: 'ping' });
    const pong = await client.next<{ t: string }>();
    expect(pong.t).toBe('pong');
  });

  it('四类不可补各自 → reset_required（谱系丢失 / 水位超前 / 差超 500 / 窗口淘汰）', async () => {
    // ① sid 谱系丢失：hasSession 变 false（会话被回收/重建）
    {
      let alive = true;
      const { security } = makeSecurity({ tier: 'observe' });
      const { ports } = makePorts({ hasSession: () => alive });
      const { client } = await openLanSub(ports, security);
      alive = false;
      client.send({ t: 'resume', upSeq: 1, recvSeq: 0, sid: 's1' });
      expect((await client.next<{ t: string }>()).t).toBe('reset_required');
    }
    // ② 手机水位超前：recvSeq > sentSeq
    {
      const { security } = makeSecurity({ tier: 'observe' });
      const { bridge, client } = await openLanSub(makePorts().ports, security);
      bridge.notifyTurnUpdate('s1');
      await client.next();
      client.send({ t: 'resume', upSeq: 1, recvSeq: 2, sid: 's1' });
      expect((await client.next<{ t: string }>()).t).toBe('reset_required');
    }
    // ③ 缺口超 500：差 > 500 条即使窗口保留最后 500 条也不可补
    {
      const { security } = makeSecurity({ tier: 'observe' });
      const { bridge, client } = await openLanSub(makePorts().ports, security);
      for (let i = 0; i < 501; i += 1) bridge.notifyTurnUpdate('s1');
      for (let i = 0; i < 501; i += 1) await client.next();
      client.send({ t: 'resume', upSeq: 1, recvSeq: 0, sid: 's1' });
      expect((await client.next<{ t: string }>()).t).toBe('reset_required');
    }
    // ④ 2MB 窗口淘汰：单帧超窗后旧 seq 被挤出，差虽小仍不可补
    {
      const { security } = makeSecurity({ tier: 'observe' });
      const huge = { phase: 'idle', giant: 'x'.repeat(2 * 1024 * 1024) } as unknown as TurnState;
      const { ports } = makePorts({
        snapshot: () => ({ state: huge, rounds: ROUNDS, pendingQueue: [] }),
      });
      const { bridge, client } = await openLanSub(ports, security);
      bridge.notifyTurnUpdate('s1');
      bridge.notifyTurnUpdate('s1');
      await client.next();
      await client.next();
      client.send({ t: 'resume', upSeq: 1, recvSeq: 1, sid: 's1' });
      expect((await client.next<{ t: string }>()).t).toBe('reset_required');
    }
  });

  // ─── 流中 250ms tick（宿主逐 chunk 不通知，桥侧补推富增量） ──────────────

  it('running 订阅后 notifyTurnUpdate 武装 tick；tick 只补推 append_text（不发 status）', async () => {
    const running: TurnState = { phase: 'running', roundId: 'r1' };
    let current = makeLiveRound('你好');
    const { security } = makeSecurity({ tier: 'observe' });
    const { ports } = makePorts({
      snapshot: () => ({ state: running, rounds: [current], pendingQueue: [] }),
    });
    const { bridge, client } = await openLanSub(ports, security);

    // 正文增长 → 生命周期通知推 status + append_text，并因 running 武装 tick
    current = makeLiveRound('你好世界');
    bridge.notifyTurnUpdate('s1');
    const status = await client.next<{ seq: number; p: { kind: string } }>();
    expect(status.p.kind).toBe('status');
    const text = await client.next<{ seq: number; p: unknown }>();
    expect(text.p).toEqual({ kind: 'append_text', roundId: 'r1', text: '世界' });

    // 白盒：tick 已武装
    const internals = bridge as unknown as {
      connections: Set<{ timers?: Map<string, unknown> }>;
      onStreamTick: (conn: unknown, sid: string) => void;
    };
    const conn = [...internals.connections][0]!;
    expect(conn.timers?.has('s1')).toBe(true);

    // 再增长后直接驱动一拍 tick：只应收到 append_text，绝不能夹带 status
    current = makeLiveRound('你好世界！');
    internals.onStreamTick(conn, 's1');
    const tickFrame = await client.next<{ seq: number; p: unknown }>();
    expect(tickFrame.p).toEqual({ kind: 'append_text', roundId: 'r1', text: '！' });
    // ping/pong 探帧：若 tick 多发一帧 status，下一条就不会是 pong
    client.send({ t: 'ping' });
    expect((await client.next<{ t: string }>()).t).toBe('pong');
  });

  it('流中撤回触发前缀断裂 → tick 补快照全量重建 + 水位归零（消流中错帧）', async () => {
    const running: TurnState = { phase: 'running', roundId: 'r1' };
    let current = makeLiveRound('');
    const { security } = makeSecurity({ tier: 'observe' });
    const { ports } = makePorts({
      snapshot: () => ({ state: running, rounds: [current], pendingQueue: [] }),
    });
    const { bridge, client } = await openLanSub(ports, security);
    const internals = bridge as unknown as {
      connections: Set<{ timers?: Map<string, unknown> }>;
      onStreamTick: (conn: unknown, sid: string) => void;
    };
    const conn = [...internals.connections][0]!;

    // ① 过渡叙述逐字流式发出（真机 15 字错帧的形成路径）
    current = makeLiveRound('先');
    bridge.notifyTurnUpdate('s1');
    expect((await client.next<{ p: { kind: string } }>()).p.kind).toBe('status');
    expect((await client.next<{ p: unknown }>()).p).toEqual({
      kind: 'append_text',
      roundId: 'r1',
      text: '先',
    });
    expect(conn.timers?.has('s1')).toBe(true);
    current = makeLiveRound('先找一下项目里有没有这个文件。');
    internals.onStreamTick(conn, 's1');
    expect((await client.next<{ p: unknown }>()).p).toEqual({
      kind: 'append_text',
      roundId: 'r1',
      text: '找一下项目里有没有这个文件。',
    });

    // ② 宿主按内核 withdrawn 扣回 live 正文 → 前缀断裂 → 下一拍 tick 补快照全量重建
    current = makeLiveRound('');
    internals.onStreamTick(conn, 's1');
    const resync = await client.next<{
      seq: number;
      kind: string;
      p: { rounds: Array<{ assistantMessage?: { content: string } }> };
    }>();
    expect(resync).toMatchObject({ seq: 0, kind: 'snapshot' });
    expect(resync.p.rounds[0]?.assistantMessage?.content ?? '').toBe('');
    // ping 探底：resync 只补快照，不再夹带错位 append_text
    client.send({ t: 'ping' });
    expect((await client.next<{ t: string }>()).t).toBe('pong');

    // ③ 水位归零实证：快照后第一帧增量从 seq=1 起；真实正文照常增量续推
    current = makeLiveRound('真实正文');
    bridge.notifyTurnUpdate('s1');
    expect((await client.next<{ seq: number }>()).seq).toBe(1);
    expect((await client.next<{ p: unknown }>()).p).toEqual({
      kind: 'append_text',
      roundId: 'r1',
      text: '真实正文',
    });
  });

  it('会话离开 running 后一拍 tick 自动停表（waiting 不推富增量）', async () => {
    let phase: TurnState = { phase: 'running', roundId: 'r1' };
    const { security } = makeSecurity({ tier: 'observe' });
    const { ports } = makePorts({
      snapshot: () => ({ state: phase, rounds: [makeLiveRound('流中')], pendingQueue: [] }),
    });
    const { bridge, client } = await openLanSub(ports, security);
    bridge.notifyTurnUpdate('s1');
    await client.next(); // status（正文无增长，无富帧）

    const internals = bridge as unknown as {
      connections: Set<{ timers?: Map<string, unknown> }>;
      onStreamTick: (conn: unknown, sid: string) => void;
    };
    const conn = [...internals.connections][0]!;
    expect(conn.timers?.has('s1')).toBe(true);

    // 转 waiting：tick 该自行停表且不发任何帧
    phase = WAITING_ASK;
    internals.onStreamTick(conn, 's1');
    expect(conn.timers?.has('s1')).toBe(false);
    client.send({ t: 'ping' });
    expect((await client.next<{ t: string }>()).t).toBe('pong');
  });

  it('退订停掉 tick；回环档（无 security）即使在 running 也不武装', async () => {
    const running: TurnState = { phase: 'running', roundId: 'r1' };
    const mkPorts = () =>
      makePorts({
        snapshot: () => ({ state: running, rounds: [makeLiveRound('流中')], pendingQueue: [] }),
      });

    // ① LAN 档：武装后退订 → tick 清空
    const { security } = makeSecurity({ tier: 'observe' });
    const lan = mkPorts();
    const { bridge, client } = await openLanSub(lan.ports, security);
    bridge.notifyTurnUpdate('s1');
    await client.next(); // status
    const internals = bridge as unknown as {
      connections: Set<{ timers?: Map<string, unknown> }>;
    };
    const conn = [...internals.connections][0]!;
    expect(conn.timers?.has('s1')).toBe(true);
    client.send({ t: 'unsub', sid: 's1' });
    await waitUntil(() => conn.timers?.has('s1') === false);

    // ② 回环档：running 订阅后仍整帧快照，绝不武装 tick
    const loop = mkPorts();
    const { bridge: loopBridge, port: loopPort } = await startBridge(loop.ports);
    const loopClient = await TestClient.connect(loopPort);
    const entry = opened.find((item) => item.bridge === loopBridge);
    if (entry) entry.client = loopClient;
    else opened.push({ bridge: loopBridge, client: loopClient });
    loopClient.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await loopClient.next();
    loopClient.send({ t: 'sub', sid: 's1' });
    await loopClient.next(); // snapshot
    loopBridge.notifyTurnUpdate('s1');
    expect((await loopClient.next<{ kind: string }>()).kind).toBe('snapshot');
    const loopInternals = loopBridge as unknown as {
      connections: Set<{ timers?: Map<string, unknown> }>;
    };
    expect(loopInternals.connections.size).toBe(1);
    expect([...loopInternals.connections][0]!.timers?.size ?? 0).toBe(0);
  });
});

describe('RemoteBridge — 手机直接新建会话（ctl 帧 session_create）', () => {
  /** LAN 档 hello（已配对指纹 ⇒ 直接 hello_ok，不弹批准） */
  async function openLan(
    ports: RemoteBridgePorts,
    tier: RemoteDeviceTier,
  ): Promise<{ client: TestClient; audits: Array<{ event: string }> }> {
    const { security, state } = makeSecurity({ tier });
    const { bridge, port } = await startBridge(ports, security);
    const client = await TestClient.connect(port);
    const entry = opened.find((item) => item.bridge === bridge);
    if (entry) entry.client = client;
    else opened.push({ bridge, client });
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: DEVICE_FP });
    await client.next();
    return { client, audits: state.audits };
  }

  it('回环档拒绝：回 forbidden 且**不调**宿主建会话（profile 2 只放行 answer）', async () => {
    let called = false;
    const { ports } = makePorts({
      createSession: async () => {
        called = true;
        return { ok: true, sid: 'should-not-exist', title: 'x' };
      },
    });
    const { bridge, port } = await startBridge(ports);
    const client = await TestClient.connect(port);
    const entry = opened.find((item) => item.bridge === bridge);
    if (entry) entry.client = client;
    else opened.push({ bridge, client });
    client.send({ t: 'hello', v: 1, deviceId: 'd1', nonce: 'n1', phoneFp: 'AB12' });
    await client.next();
    client.send({ t: 'session_create', rid: 'c-loop' });
    const err = await client.next<{ t: string; code: string; rid?: string }>();
    expect(err.t).toBe('err');
    expect(err.code).toBe('forbidden');
    expect(err.rid).toBe('c-loop');
    expect(called).toBe(false);
  });

  it('observe 档拒绝（只读不给写入口）；send 档放行并回 session_created + 审计', async () => {
    const { ports } = makePorts({
      createSession: async ({ title }) => ({
        ok: true,
        sid: '2026-11-28-snew',
        title: title ?? '新会话',
      }),
    });

    const observe = await openLan(ports, 'observe');
    observe.client.send({ t: 'session_create', rid: 'c-observe' });
    const denied = await observe.client.next<{ t: string; code: string }>();
    expect(denied.t).toBe('err');
    expect(denied.code).toBe('forbidden');

    const send = await openLan(ports, 'send');
    send.client.send({ t: 'session_create', rid: 'c-send', title: '整理周报' });
    const created = await send.client.next<Record<string, unknown>>();
    // 独立手写期望：身份（sid）必须由宿主显式下发，字段漂移必须红
    expect(created).toEqual({
      t: 'session_created',
      ch: 'ctl',
      rid: 'c-send',
      sid: '2026-11-28-snew',
      title: '整理周报',
    });
    await waitAudit(send.audits, 'session_created');
  });

  it('宿主建会话失败 → forbidden（不伪造 sid）', async () => {
    const { ports } = makePorts({ createSession: async () => ({ ok: false }) });
    const { client } = await openLan(ports, 'send');
    client.send({ t: 'session_create', rid: 'c-fail' });
    const err = await client.next<{ t: string; code: string; rid?: string }>();
    expect(err.t).toBe('err');
    expect(err.code).toBe('forbidden');
    expect(err.rid).toBe('c-fail');
  });

  it('role_list 逐字下发；session_create.role 原样交给宿主（桥不校验存在性）', async () => {
    const seen: Array<{ title?: string; role?: string }> = [];
    const { ports } = makePorts({
      listRolePacks: () => ({
        packs: [{ name: '共鸣小说家', displayName: '共鸣小说家', description: '写小说' }],
        defaultName: '共鸣小说家',
      }),
      createSession: async (options) => {
        seen.push(options);
        return { ok: true as const, sid: 's-new', title: '新会话' };
      },
    });
    const { client } = await openLan(ports, 'send');

    client.send({ t: 'role_list', rid: 'rl-1' });
    const list = await client.next<Record<string, unknown>>();
    // 独立手写期望：列表只转述宿主投影，桥不增删字段
    expect(list).toEqual({
      t: 'role_list_ok',
      ch: 'ctl',
      rid: 'rl-1',
      packs: [{ name: '共鸣小说家', displayName: '共鸣小说家', description: '写小说' }],
      defaultName: '共鸣小说家',
    });

    client.send({ t: 'session_create', rid: 'c-role', role: '共鸣小说家' });
    await client.next<Record<string, unknown>>();
    // 存在性校验在宿主的目录编目：桥传什么宿主就收到什么（传错名由宿主回落，不在此判）
    expect(seen).toHaveLength(1);
    expect(seen[0]!.role).toBe('共鸣小说家');
    expect(seen[0]!.title).toBeUndefined();
  });
});
