/**
 * 远程桥端到端单测 —— 真 `ws` 客户端连 `127.0.0.1`，验证 profile 2 的四条链路
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §19.3 profile 2
 *   （本地客户端跑通 hello / session_list / evt / cmd；端口占用显式报错）
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { RoundView, TurnState } from '../../../../shared/protocol.js';
import { RemoteBridge, type RemoteBridgePorts } from '../remoteBridge.js';

/** 单帧等待上限（防用例挂死；正常应远小于它） */
const FRAME_TIMEOUT = 2000;

/**
 * 测试用 WS 客户端：按到达顺序消费下行帧
 */
class TestClient {
  private readonly inbox: unknown[] = [];
  private readonly waiters: Array<(frame: unknown) => void> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const frame: unknown = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.inbox.push(frame);
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
}

/** 一个会话的假投影素材（`attachmentUris` 用来验证出桥前被剥掉） */
const ROUNDS: readonly RoundView[] = [
  { id: 'r1', attachmentUris: ['vscode-webview://x.png'] } as unknown as RoundView,
];

const IDLE: TurnState = { phase: 'idle' };
const WAITING_ASK: TurnState = { phase: 'waiting', reason: 'ask' };

/**
 * 构造假 ports（默认：一个会话 s1、waiting-ask；投递记录进 `delivered`）
 */
function makePorts(overrides: Partial<RemoteBridgePorts> = {}): {
  ports: RemoteBridgePorts;
  delivered: Array<{ sid: string; answers: readonly string[] }>;
} {
  const delivered: Array<{ sid: string; answers: readonly string[] }> = [];
  const state: TurnState = WAITING_ASK;
  const ports: RemoteBridgePorts = {
    listSessions: () => ({
      sessions: [{ sessionId: 's1', title: '会话一', updatedAt: '2026-11-26T00:00:00Z' }],
      archivedIds: [],
      assistantSid: 'assist-1',
    }),
    hasSession: (sid) => sid === 's1',
    phaseOf: () => (state.phase === 'waiting' ? 'waiting-ask' : 'idle'),
    snapshot: () => ({ state, rounds: ROUNDS, pendingQueue: [] }),
    deliverAnswer: (sid, answers) => delivered.push({ sid, answers }),
    ...overrides,
  };
  return { ports, delivered };
}

/** 起一个桥并连一个客户端（用例结束统一 close，避免句柄泄漏） */
const opened: Array<{ bridge: RemoteBridge; client?: TestClient }> = [];

async function startBridge(
  ports: RemoteBridgePorts,
): Promise<{ bridge: RemoteBridge; port: number }> {
  const bridge = new RemoteBridge(ports, { pcId: 'pc-test' });
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
    const helloOk = await client.next<{ t: string; pcId: string; assistantSid?: string }>();
    expect(helloOk.t).toBe('hello_ok');
    expect(helloOk.pcId).toBe('pc-test');
    expect(helloOk.assistantSid).toBe('assist-1');

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
    expect(delivered).toEqual([{ sid: 's1', answers: ['第一问', '', '第三问'] }]);
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
