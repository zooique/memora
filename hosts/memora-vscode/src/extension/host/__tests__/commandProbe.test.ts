/**
 * 命令预检（commandProbe）— 「配置错了」必须给得出人话
 *
 * 为什么必须单独测：`McpConnection` 用的是真连接，而 MCP 编排测试全部注入假连接
 * （假连接不 spawn，也就绕过预检）⇒ 预检逻辑在编排测试里**零覆盖**。这里用真实
 * 临时文件与真实 PATH 把每条判据钉住。
 *
 * 判据边界（勿扩大）：只判「静态可判」的必然失败，不判可执行位 / 依赖 / 端口。
 */
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCommand, scriptNeedsInterpreter } from '../mcp/commandProbe.js';

/** 临时目录（每个用例自造文件，不依赖仓库内容） */
let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'memora-probe-'));
  writeFileSync(join(dir, 'server.mjs'), 'console.log("hi");\n', 'utf8');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'notes.txt'), 'x', 'utf8');
  // 相对路径基准用例：cwd 内一层 + 两处同名文件（dup.mjs 同时存在于根与 sub）
  writeFileSync(join(dir, 'sub', 'inner.mjs'), 'console.log("inner");\n', 'utf8');
  writeFileSync(join(dir, 'dup.mjs'), 'console.log("root");\n', 'utf8');
  writeFileSync(join(dir, 'sub', 'dup.mjs'), 'console.log("sub");\n', 'utf8');
  // 平台差异用例：一个有执行位（POSIX 可直接拉起）、一个没有
  writeFileSync(join(dir, 'exec-server.js'), '#!/usr/bin/env node\n', {
    encoding: 'utf8',
    mode: 0o755,
  });
  writeFileSync(join(dir, 'plain-server.js'), '#!/usr/bin/env node\n', 'utf8');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('commandProbe / command 字段', () => {
  it('空命令 ⇒ 明确说缺什么', () => {
    const r = probeCommand({ command: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain('缺少 command');
  });

  it('绝对路径不存在 ⇒ 报绝对路径（而不是 Connection closed）', () => {
    const r = probeCommand({ command: join(dir, 'ghost-binary') });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain('找不到可执行文件');
      expect(r.problem).toContain('ghost-binary');
    }
  });

  it('把脚本文件当命令 ⇒ 指路「命令填 node，脚本放参数」', () => {
    const r = probeCommand({ command: join(dir, 'server.mjs') });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain('脚本文件');
      expect(r.problem).toContain('命令填 node');
    }
  });

  it('相对路径按 baseDir 解析，返回值是绝对路径（判据与实现同源）', () => {
    const r = probeCommand({ command: './server.mjs', baseDir: dir });
    // 脚本仍判失败，但报错里必须是解析后的绝对路径
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain(join(dir, 'server.mjs'));
  });

  it('裸名在 PATH 里 ⇒ 通过，且命令原样保留（不擅自改成绝对路径）', () => {
    const r = probeCommand({ command: 'node' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.command).toBe('node');
  });

  it('裸名不在 PATH 里 ⇒ 说清「PATH 里找不到」并给两条出路', () => {
    const r = probeCommand({ command: 'definitely-no-such-mcp-binary' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain('PATH 里找不到');
      expect(r.problem).toContain('node');
    }
  });

  it('真实可执行文件（node 自身）⇒ 通过并给出绝对路径', () => {
    const r = probeCommand({ command: process.execPath });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.command).toBe(process.execPath);
  });
});

describe('commandProbe / cwd 字段', () => {
  it('cwd 不存在 ⇒ 报绝对路径（不要等 spawn 出 ENOENT）', () => {
    const r = probeCommand({ command: 'node', cwd: join(dir, 'no-such-dir') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain('工作目录不存在');
  });

  it('cwd 指向文件 ⇒ 说清「不是文件夹」', () => {
    const r = probeCommand({ command: 'node', cwd: join(dir, 'notes.txt') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain('不是文件夹');
  });

  it('cwd 是相对路径 ⇒ 按 baseDir 解析成绝对路径', () => {
    const r = probeCommand({ command: 'node', cwd: './sub', baseDir: dir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.cwd).toBe(join(dir, 'sub'));
  });

  it('未配 cwd ⇒ 不返回 cwd（保持 SDK 缺省语义，不偷偷注入）', () => {
    const r = probeCommand({ command: 'node' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.cwd).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────
// 判据面 = 字段面：面板保存已保真（不 trim），预检不得悄悄改写值。
// 早先预检对 command / cwd 先 trim 再解析 ⇒ 「判定按 A、spawn 按 B」：
// 带尾随空格的 command 预检说没事、拉起必失败（假阴性）。
// ──────────────────────────────────────────────────────────────
describe('commandProbe / 值不改写（判据面 = 字段面）', () => {
  it('cwd 带前导空格 ⇒ 按原值解析（trim 会把它误判成存在的 ./sub）', () => {
    // `'  ./sub'` 若被 trim ⇒ 解析成 <dir>/sub（存在、判 ok）；原值 ⇒ <dir>/'  ./sub'（不存在）
    const r = probeCommand({ command: 'node', cwd: '  ./sub', baseDir: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain('工作目录不存在');
  });

  it('cwd 全空白 ⇒ 视作未配置（与面板保存「空白 = 清空」同口径）', () => {
    const r = probeCommand({ command: process.execPath, cwd: '   ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.cwd).toBeUndefined();
  });

  it('command 带尾随空格 ⇒ 按原值判失败（不 trim 出假通过）', () => {
    const r = probeCommand({ command: 'node   ' });
    expect(r.ok).toBe(false);
  });
});

describe('commandProbe / args 第一项', () => {
  it('args[0] 是绝对路径且不存在 ⇒ 提前报（最常见的「脚本路径写错」）', () => {
    const r = probeCommand({ command: 'node', args: [join(dir, 'ghost-server.js')] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain('参数里的文件不存在');
      expect(r.problem).toContain('ghost-server.js');
    }
  });

  it('args[0] 是存在的绝对路径 ⇒ 通过并转成绝对', () => {
    const target = join(dir, 'server.mjs');
    const r = probeCommand({ command: 'node', args: [target] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.args[0]).toBe(target);
  });

  it('args[0] 不是路径形态（-y / run）⇒ 不做文件判定（npx 包名不是路径）', () => {
    const r = probeCommand({ command: 'node', args: ['-y'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.args).toEqual(['-y']);
  });

  // 2026-10-24 实测的误杀面：「含 `/`」被当成「本地文件」。
  // 官方最常见的写法就是不带 -y 的 `npx @scope/pkg`，args[0] 直接是包名。
  // ⚠️ command 用 `node` 而不是 `npx`：判据在 args 位、与 command 是什么无关，
  // 而 node 一定在 PATH（本进程就是它）⇒ 用例不依赖环境里有没有 npx。
  it('args[0] 是 npm scope 包名（含 `/`，不带 -y）⇒ 通过，不按文件判', () => {
    const r = probeCommand({
      command: 'node',
      args: ['@modelcontextprotocol/server-filesystem', '/tmp'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.args[0]).toBe('@modelcontextprotocol/server-filesystem');
  });

  it('args[0] 是 URL ⇒ 通过，不按文件判', () => {
    const r = probeCommand({ command: 'node', args: ['https://example.com/x.tar.gz'] });
    expect(r.ok).toBe(true);
  });

  it('args[0] 是带子路径的包名 ⇒ 通过（`pkg/sub` 不是相对路径）', () => {
    const r = probeCommand({ command: 'node', args: ['ts-node/register'] });
    expect(r.ok).toBe(true);
  });

  it('args[0] 是裸相对脚本名 ⇒ 不判（与包名形态无法静态区分，宁可漏判）', () => {
    // 这条是**刻意的不判**：`node server.js` 与 `npx mcp-server-git` 的 args[0] 形态相同。
    // 写成断言是为了防止将来有人「顺手补一条」把 npx 包名全判死（回归到 2026-10-24 的缺陷）。
    const r = probeCommand({ command: 'node', args: ['no-such-server.js'], baseDir: dir });
    expect(r.ok).toBe(true);
  });

  it('args[0] 是带引号的绝对路径 ⇒ 剥引号后判存在，并把剥掉的值交给 spawn', () => {
    const target = join(dir, 'server.mjs');
    const r = probeCommand({ command: 'node', args: [`"${target}"`] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.args[0]).toBe(target);
  });
});

// ──────────────────────────────────────────────────────────────
// 相对路径基准：子进程是「先 chdir 再执行」，配了 cwd 时 ./x 指的是 cwd 下的 x。
// 一律按 baseDir 解析会造两种伤：① 不存在 ⇒ 原本能跑的配置被判失败；
// ② baseDir 下恰好有同名文件 ⇒ 悄悄换成另一个文件（比失败更糟）。
// ──────────────────────────────────────────────────────────────
describe('commandProbe / 相对路径基准跟随 cwd', () => {
  it('配了 cwd ⇒ 相对 args[0] 按 cwd 解析（不是按 baseDir）', () => {
    const r = probeCommand({ command: 'node', args: ['./inner.mjs'], cwd: './sub', baseDir: dir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.args[0]).toBe(join(dir, 'sub', 'inner.mjs'));
  });

  it('baseDir 与 cwd 各有同名文件 ⇒ 必须取 cwd 那份（防悄悄换成另一个文件）', () => {
    const r = probeCommand({ command: 'node', args: ['./dup.mjs'], cwd: './sub', baseDir: dir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.args[0]).toBe(join(dir, 'sub', 'dup.mjs'));
  });

  it('未配 cwd ⇒ 相对 args[0] 仍按 baseDir（既有语义不回归）', () => {
    const r = probeCommand({ command: 'node', args: ['./server.mjs'], baseDir: dir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.args[0]).toBe(join(dir, 'server.mjs'));
  });

  it('相对 command 同样跟随 cwd', () => {
    const r = probeCommand({ command: './inner.mjs', cwd: './sub', baseDir: dir });
    // inner.mjs 是脚本 ⇒ 仍判失败，但报错里必须是 cwd 下的绝对路径
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain(join(dir, 'sub', 'inner.mjs'));
  });
});

describe('commandProbe / 平台差异与引号', () => {
  // 平台分支用纯判据断言：否则「POSIX 允许可执行脚本」这条只有跑到 macOS 的 CI 才可能红，
  // 在 Windows 开发机上永远绿 = 守没守住无从得知。
  it('Windows：脚本一律要解释器（无执行位语义，CreateProcess 不认 shebang）', () => {
    expect(scriptNeedsInterpreter('win32', false)).toBe(true);
    expect(scriptNeedsInterpreter('win32', true)).toBe(true);
  });

  it('POSIX：有执行位就不强制解释器；无执行位仍强制', () => {
    expect(scriptNeedsInterpreter('darwin', true)).toBe(false);
    expect(scriptNeedsInterpreter('linux', true)).toBe(false);
    expect(scriptNeedsInterpreter('linux', false)).toBe(true);
  });

  it('引号包裹的绝对路径 ⇒ 剥掉引号并通过（并从 spawn 一侧也拿到无引号值）', () => {
    const r = probeCommand({ command: `"${process.execPath}"` });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.command).toBe(process.execPath);
  });

  // Windows 无执行位语义，「可执行脚本」不存在；POSIX 上 execvp 能直接拉起带 shebang 的脚本。
  it.skipIf(process.platform === 'win32')(
    'POSIX 可执行脚本当命令 ⇒ 通过（拒绝会误杀能跑的配置）',
    () => {
      const r = probeCommand({ command: join(dir, 'exec-server.js') });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.resolved.command).toBe(join(dir, 'exec-server.js'));
    },
  );

  it('POSIX 无执行位的脚本当命令 ⇒ 仍拒（这才是必然失败）', () => {
    const r = probeCommand({ command: join(dir, 'plain-server.js') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain('脚本文件');
  });
});
