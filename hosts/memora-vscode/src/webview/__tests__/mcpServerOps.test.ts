/**
 * MCP 写操作（`mcp_write` 五个 op）— 设置面板唯一写入路径
 *
 * 覆盖被测不变量：
 *   ① 写入落点正确（`mcpServers` / `mcpToolAllowlist`，均为 Global）；
 *   ② `upsert` 按 name 定位并**保留未知字段**（编辑动作不销毁表单不认识的键）；
 *   ③ 非法配置（缺 command）**不写入**且给回执（判据与启动侧同源 = configProblem）；
 *   ④ 写失败必须 `notice('error')`（首版静默 unhandled rejection 是缺陷）；
 *   ⑤ `remove` 不联动清 allowlist（授权记录是用户数据，删服务器不该顺带抹掉）。
 *
 * 为什么必须测：这些分支全是「写用户配置」的破坏性动作，写错一个键位或丢一个字段
 * 都是静默的数据损失，且没有编译期护栏（配置是 array<object>）。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** vscode 替身：内存配置表（get/update 的行为与真实 API 对齐到本测试所需的最小面） */
const h = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  update: (_key: string, _value: unknown) => Promise.resolve(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key in h.data ? h.data[key] : fallback),
      update: (key: string, value: unknown) => h.update(key, value),
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

import { applyMcpWrite, type McpOpsDeps } from '../panels/mcpServerOps.js';

/** 记录回执 / 回推的依赖桩 */
function deps(
  restart: McpOpsDeps['restart'] = async () => ({ ok: true }),
  connect: McpOpsDeps['connect'] = async () => ({ ok: true }),
): McpOpsDeps & {
  notices: { level: string; message: string }[];
  pushes: number;
  connects: number;
  acks: { reqId: string; ok: boolean; error?: string }[];
} {
  const notices: { level: string; message: string }[] = [];
  const acks: { reqId: string; ok: boolean; error?: string }[] = [];
  const bag = {
    notices,
    pushes: 0,
    connects: 0,
    acks,
    pushStatus: (ack?: { reqId: string; ok: boolean; error?: string }) => {
      bag.pushes += 1;
      if (ack) acks.push(ack);
    },
    notice: (level: 'info' | 'error', message: string) => {
      notices.push({ level, message });
    },
    restart,
    connect: () => {
      bag.connects += 1;
      return connect();
    },
  };
  return bag;
}

/** 写入失败开关：让 update 拒绝（模拟只读配置 / 策略锁） */
function failWrites(): void {
  h.update = () => Promise.reject(new Error('配置只读'));
}

beforeEach(() => {
  h.data = {};
  h.update = (key, value) => {
    h.data[key] = value;
    return Promise.resolve();
  };
});

describe('mcp_write / allow（免确认档位）', () => {
  it('加入：写进 mcpToolAllowlist，保留既有条目', async () => {
    h.data['mcpToolAllowlist'] = ['mcp__a__x'];
    const d = deps();
    await applyMcpWrite(d, { op: 'allow', key: 'mcp__fs__read-file', allowlisted: true });
    expect(h.data['mcpToolAllowlist']).toEqual(['mcp__a__x', 'mcp__fs__read-file']);
    expect(d.pushes).toBeGreaterThan(0);
  });

  it('移除：只删目标键', async () => {
    h.data['mcpToolAllowlist'] = ['mcp__a__x', 'mcp__fs__read-file'];
    await applyMcpWrite(deps(), { op: 'allow', key: 'mcp__fs__read-file', allowlisted: false });
    expect(h.data['mcpToolAllowlist']).toEqual(['mcp__a__x']);
  });

  it('写失败 → notice(error)，不抛（勾选已还原，沉默等于「点了没反应」）', async () => {
    failWrites();
    const d = deps();
    await expect(
      applyMcpWrite(d, { op: 'allow', key: 'k', allowlisted: true }),
    ).resolves.toBeUndefined();
    expect(d.notices[0]?.level).toBe('error');
    expect(d.notices[0]?.message).toContain('免确认设置写入失败');
  });
});

describe('mcp_write / upsert（增改）', () => {
  it('新增：追加一条，空 args/env/cwd 不落盘（配置保持干净）', async () => {
    const d = deps();
    await applyMcpWrite(d, {
      op: 'upsert',
      server: { name: 'fs', command: 'npx' },
    });
    expect(h.data['mcpServers']).toEqual([{ name: 'fs', command: 'npx', enabled: true }]);
    expect(d.notices[0]?.level).toBe('info');
  });

  it('更新：按 name 定位并展开合并 ⇒ 表单不认识的字段原样保留（不带伤）', async () => {
    h.data['mcpServers'] = [
      { name: 'fs', command: 'npx', args: ['-y', 'x'], timeout: 30, headers: { a: 'b' } },
    ];
    await applyMcpWrite(deps(), {
      op: 'upsert',
      server: { name: 'fs', command: 'node', args: ['server.js'] },
      originalName: 'fs',
    });
    const written = h.data['mcpServers'] as Record<string, unknown>[];
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ name: 'fs', command: 'node', args: ['server.js'] });
    // 未知字段（将来新增的 timeout/headers）不能被编辑动作冲掉
    expect(written[0]?.timeout).toBe(30);
    expect(written[0]?.headers).toEqual({ a: 'b' });
  });

  it('清空 args/env：表单删除必须真的落盘（旧值不得复活）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } }];
    // 表单在全空时不发这三个键 —— host 侧必须把「没发」当「删了」，而不是「保持旧值」
    await applyMcpWrite(deps(), {
      op: 'upsert',
      server: { name: 'fs', command: 'npx' },
      originalName: 'fs',
    });
    const saved = (h.data['mcpServers'] as Record<string, unknown>[])[0]!;
    expect(saved.args).toBeUndefined();
    expect(saved.env).toBeUndefined();
    expect(saved.command).toBe('npx');
  });

  it('清空 cwd：同上（曾因 `空则不写` 而让旧工作目录复活）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'npx', cwd: '/tmp/x' }];
    await applyMcpWrite(deps(), {
      op: 'upsert',
      server: { name: 'fs', command: 'npx' },
      originalName: 'fs',
    });
    const saved = (h.data['mcpServers'] as Record<string, unknown>[])[0]!;
    expect(saved.cwd).toBeUndefined();
  });

  it('清空只影响表单认识的三个字段：未知字段仍原样保留', async () => {
    h.data['mcpServers'] = [
      { name: 'fs', command: 'npx', args: ['-y'], timeout: 30, headers: { a: 'b' } },
    ];
    await applyMcpWrite(deps(), {
      op: 'upsert',
      server: { name: 'fs', command: 'node' },
      originalName: 'fs',
    });
    const saved = (h.data['mcpServers'] as Record<string, unknown>[])[0]!;
    expect(saved.args).toBeUndefined();
    expect(saved.timeout).toBe(30);
    expect(saved.headers).toEqual({ a: 'b' });
  });

  it('非法配置不写入：缺 command ⇒ notice(error) + 配置不变（判据与启动侧同源）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'npx' }];
    const d = deps();
    await applyMcpWrite(d, { op: 'upsert', server: { name: 'bad', command: '   ' } });
    expect((h.data['mcpServers'] as unknown[]).length).toBe(1);
    expect(d.notices[0]?.level).toBe('error');
    expect(d.notices[0]?.message).toContain('缺少 command');
  });

  it('写失败 → notice(error)（不假装成功）', async () => {
    failWrites();
    const d = deps();
    await applyMcpWrite(d, { op: 'upsert', server: { name: 'fs', command: 'npx' } });
    expect(d.notices.some((n) => n.level === 'error')).toBe(true);
  });
});

/**
 * 重名预检（fail-closed，2026-10-24 ⑦）
 *
 * 守的是「新增撞已有名 ⇒ 拒绝而不是静默覆盖」：upsert 按归一化名定位，命中且**不是保存
 * 自己**（originalName 归一化后 ≠ 新名）就拒绝并给出路。放行的唯一形态 = 编辑保存自己
 * （配置原值带空格也算——判据两侧都走归一化）。
 */
describe('mcp_write / upsert 重名预检', () => {
  it('新增撞已有名 ⇒ 不写入 + ack{ok:false}（出路写进错误：先删或换名）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node', args: ['-y', 'pkg'] }];
    const d = deps();
    await applyMcpWrite(d, {
      op: 'upsert',
      server: { name: 'fs', command: 'npx' },
      reqId: 'r1',
    });
    // 落盘未变：旧配置的 command/args 没有被冲掉（原缺陷 = 原地合并覆盖 + 回执「已更新」）
    expect(h.data['mcpServers']).toEqual([{ name: 'fs', command: 'node', args: ['-y', 'pkg'] }]);
    expect(d.notices[0]?.level).toBe('error');
    expect(d.notices[0]?.message).toContain('覆盖');
    expect(d.acks).toEqual([{ reqId: 'r1', ok: false, error: expect.stringContaining('覆盖') }]);
  });

  it('归一化撞车：新增名带首尾空格也拦得住（判据两侧同走 normalizeServerName）', async () => {
    h.data['mcpServers'] = [{ name: 'fs', command: 'node' }];
    const d = deps();
    await applyMcpWrite(d, { op: 'upsert', server: { name: '  fs  ', command: 'npx' } });
    expect(h.data['mcpServers']).toEqual([{ name: 'fs', command: 'node' }]);
    expect(d.notices[0]?.level).toBe('error');
  });

  it('改名撞别的（防御性：协议留了 originalName，未来表单放开只读也拦得住）', async () => {
    h.data['mcpServers'] = [
      { name: 'a', command: 'node' },
      { name: 'b', command: 'node' },
    ];
    const d = deps();
    await applyMcpWrite(d, {
      op: 'upsert',
      server: { name: 'b', command: 'npx' },
      originalName: 'a',
    });
    expect(h.data['mcpServers']).toEqual([
      { name: 'a', command: 'node' },
      { name: 'b', command: 'node' },
    ]);
    expect(d.notices[0]?.level).toBe('error');
  });
});

/**
 * 写操作回执（`mcp_status.ack` 随收尾回推带回）
 *
 * 守的是「视图靠 reqId 认领结论」这条链的宿主半边：成败都必须回（成功丢暂存、失败复开
 * 表单），且 reqId 原样回传——回错 id 等于把别人的结论发给别人。
 */
describe('mcp_write / ack（upsert 的结论随状态回推带回）', () => {
  it('成功 ⇒ ack{reqId, ok:true}（视图据此丢掉暂存草稿）', async () => {
    const d = deps();
    await applyMcpWrite(d, {
      op: 'upsert',
      server: { name: 'fs', command: 'npx' },
      reqId: 'r1',
    });
    expect(d.acks).toEqual([{ reqId: 'r1', ok: true }]);
  });

  it('非法配置 ⇒ ack{ok:false, error}（error 与 toast 同一句，不二次加工）', async () => {
    const d = deps();
    await applyMcpWrite(d, {
      op: 'upsert',
      server: { name: 'bad', command: '   ' },
      reqId: 'r2',
    });
    expect(d.acks).toHaveLength(1);
    expect(d.acks[0]!.ok).toBe(false);
    expect(d.acks[0]!.error).toContain('缺少 command');
  });

  it('写失败 ⇒ ack{ok:false, error}（视图据此复开表单还输入）', async () => {
    failWrites();
    const d = deps();
    await applyMcpWrite(d, { op: 'upsert', server: { name: 'fs', command: 'npx' }, reqId: 'r3' });
    expect(d.acks).toHaveLength(1);
    expect(d.acks[0]!.ok).toBe(false);
    expect(d.acks[0]!.error).toContain('写入失败');
  });

  it('无 reqId（旧客户端）⇒ 不带 ack（无从认领就不发，行为不变）', async () => {
    const d = deps();
    await applyMcpWrite(d, { op: 'upsert', server: { name: 'fs', command: 'npx' } });
    expect(d.acks).toEqual([]);
  });
});

/**
 * 写入不 settle（2026-10-24 G9 实测缺陷的钉子，台账 MCP-D1）
 *
 * 只读用户设置上 `update()` 会**先改内存并触发 onDidChangeConfiguration**（热更据此拉起
 * 子进程），随后落盘失败且 promise **永不 settle** ⇒ 回执挂死、表单关闭，用户输入被静默
 * 吞掉。这里用「永不 settle 的 update」复现同一形态，验证 5s 超时兜底必回 ack。
 */
describe('mcp_write / 写入超时兜底（update 永不 settle）', () => {
  /** 让 update 返回一个永不 settle 的 promise（真机只读设置的形态） */
  function hangWrites(): void {
    h.update = () => new Promise<void>(() => {});
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('upsert：超时后 ack{ok:false} 必回（视图据此复开表单、保住输入）', async () => {
    hangWrites();
    const d = deps();
    // 刻意不 await：断言点是「5s 后回执已到」；若超时兜底被去掉，这里立刻红而不是挂死
    void applyMcpWrite(d, {
      op: 'upsert',
      server: { name: 'g9', command: 'node' },
      reqId: 'r9',
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(d.acks).toEqual([{ reqId: 'r9', ok: false, error: expect.stringContaining('超时') }]);
    expect(d.notices[0]?.level).toBe('error');
    expect(d.notices[0]?.message).toContain('只读或被占用');
  });

  it('allow：同一上限（免确认勾选也是写用户设置，沉默 = 点了没反应）', async () => {
    hangWrites();
    const d = deps();
    void applyMcpWrite(d, { op: 'allow', key: 'mcp__fs__x', allowlisted: true });
    await vi.advanceTimersByTimeAsync(5000);

    expect(d.notices[0]?.level).toBe('error');
    expect(d.notices[0]?.message).toContain('免确认设置写入超时');
  });

  it('成功写入后不残留计时器（finally 清掉，不拖住事件循环）', async () => {
    await applyMcpWrite(deps(), { op: 'upsert', server: { name: 'fs', command: 'node' } });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('mcp_write / remove 与 setEnabled', () => {
  it('删除：按 name 移除，且不联动清 allowlist', async () => {
    h.data['mcpServers'] = [
      { name: 'a', command: 'x' },
      { name: 'b', command: 'y' },
    ];
    h.data['mcpToolAllowlist'] = ['mcp__a__t'];
    await applyMcpWrite(deps(), { op: 'remove', name: 'a' });
    expect(h.data['mcpServers']).toEqual([{ name: 'b', command: 'y' }]);
    // 授权记录属于用户数据：删 server 不抹 allowlist（重新添加同名即恢复）
    expect(h.data['mcpToolAllowlist']).toEqual(['mcp__a__t']);
  });

  it('删除不存在的名字 → notice(error)（他处已改配置时不静默）', async () => {
    h.data['mcpServers'] = [{ name: 'a', command: 'x' }];
    const d = deps();
    await applyMcpWrite(d, { op: 'remove', name: 'ghost' });
    expect(d.notices[0]?.level).toBe('error');
    expect((h.data['mcpServers'] as unknown[]).length).toBe(1);
  });

  it('停用：只改 enabled 位（可撤销动作，不删条目）', async () => {
    h.data['mcpServers'] = [{ name: 'a', command: 'x', args: ['1'] }];
    await applyMcpWrite(deps(), { op: 'setEnabled', name: 'a', enabled: false });
    expect(h.data['mcpServers']).toEqual([
      { name: 'a', command: 'x', args: ['1'], enabled: false },
    ]);
  });
});

describe('mcp_write / restart', () => {
  it('重启失败 → notice(error) 带上原因，且仍回推状态', async () => {
    const d = deps(async () => ({ ok: false, error: '未找到 server' }));
    await applyMcpWrite(d, { op: 'restart', name: 'ghost' });
    expect(d.notices[0]?.level).toBe('error');
    expect(d.notices[0]?.message).toContain('未找到 server');
    expect(d.pushes).toBeGreaterThan(0);
  });

  it('重启成功 → 不打扰（无 error 回执）', async () => {
    const d = deps(async () => ({ ok: true }));
    await applyMcpWrite(d, { op: 'restart', name: 'fs' });
    expect(d.notices).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────
// name 归一化（2026-10-24 实测缺陷）：面板下发的名来自状态面（已 trim），
// 而配置原值可能带首尾空白。三处按名匹配若用 `===`，用户会遇到
// 「删不掉 / 停不了 / 编辑变成追加一条」——全部静默或回执「未找到」。
// ──────────────────────────────────────────────────────────────
describe('mcp_write / name 归一化匹配（写侧同样单点）', () => {
  it('删除：配置里是 `fs `、面板下发 `fs` ⇒ 能删掉（不是「未找到」）', async () => {
    h.data['mcpServers'] = [{ name: 'fs ', command: 'node' }];
    const d = deps();
    await applyMcpWrite(d, { op: 'remove', name: 'fs' });
    expect(h.data['mcpServers']).toEqual([]);
    expect(d.notices[0]?.message).toContain('已删除');
  });

  it('停用：配置里是 `fs `、面板下发 `fs` ⇒ 改到那一条的 enabled 位', async () => {
    h.data['mcpServers'] = [{ name: 'fs ', command: 'node' }];
    const d = deps();
    await applyMcpWrite(d, { op: 'setEnabled', name: 'fs', enabled: false });
    expect(h.data['mcpServers']).toEqual([{ name: 'fs ', command: 'node', enabled: false }]);
    expect(d.notices[0]?.message).toContain('已停用');
  });

  it('编辑：配置里是 `fs `、表单回传 `fs` ⇒ 覆盖同一条，不追加近似项', async () => {
    h.data['mcpServers'] = [{ name: 'fs ', command: 'node', args: ['-y'] }];
    const d = deps();
    await applyMcpWrite(d, {
      op: 'upsert',
      server: { name: 'fs', command: 'npx' },
      originalName: 'fs ',
    });
    // 只有一条（`"fs "` 与 `"fs"` 两条会让运行侧按先到先得跳过后者 = 保存了却不生效）
    expect(h.data['mcpServers']).toEqual([{ name: 'fs', command: 'npx', enabled: true }]);
    expect(d.notices[0]?.message).toContain('已更新');
  });

  it('新增：表单名带首尾空格 ⇒ 落盘值归一化（面板显示什么，配置里就是什么）', async () => {
    const d = deps();
    await applyMcpWrite(d, { op: 'upsert', server: { name: '  fs  ', command: 'node' } });
    expect(h.data['mcpServers']).toEqual([{ name: 'fs', command: 'node', enabled: true }]);
  });
});

/**
 * `connect`（pending 卡片的唯一出路）
 *
 * 与 `restart` 的关键差别：restart 拒绝懒装配（只恢复已有运行时），connect 则**按当前配置
 * 让运行态追平**（未装配时先懒装配）。两者都走同一份 notice/pushStatus 收口，所以这里守的是
 * 「回执口径一致」。
 */
describe('mcp_write / connect（待接入 → 按当前配置追平）', () => {
  it('成功 ⇒ 静默（无 error 回执），但必须回推一次状态', async () => {
    const d = deps();
    await applyMcpWrite(d, { op: 'connect', name: 'fs' });

    expect(d.connects).toBe(1);
    expect(d.notices).toHaveLength(0);
    expect(d.pushes).toBe(1);
  });

  it('失败 ⇒ error 回执带卡片名与原因（点完没反应 = 缺陷），且仍回推（面板须收敛到真值）', async () => {
    const d = deps(undefined, async () => ({ ok: false, error: '装配未完成（原因见窗口提示）' }));
    await applyMcpWrite(d, { op: 'connect', name: 'fs' });

    expect(d.notices).toHaveLength(1);
    expect(d.notices[0]!.level).toBe('error');
    expect(d.notices[0]!.message).toContain('fs');
    expect(d.notices[0]!.message).toContain('装配未完成');
    expect(d.pushes).toBe(1);
  });
});
