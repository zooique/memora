/**
 * MCP 配置判据测试 — `configProblem` 的**双形态分派**（stdio / Streamable HTTP）
 *
 * 判据来源：`docs/方案-MCP远程HTTP接入-20261025.md` §5.1.1（类型面与判据）、§6 R6。
 * 本文件钉的是「面板能存进去的配置 = 启动侧认可的配置」这条同源关系：
 * `configProblem` 是启动、热更、面板保存三处共用的唯一判据，它退化或漏判一类，
 * 会让用户存进一条永远起不来的配置，或者反过来挡住一条合法配置。
 *
 * 纯函数，不碰内核、不拉起子进程、不发网络请求。
 */
import { describe, it, expect } from 'vitest';
import { configProblem, resolveTransportMode } from '../mcp/mcpConfigGuard.js';
import type { McpServerConfig } from '../mcp/connectionManager.js';

/**
 * 构造一条配置（测试只需覆写关心的字段）
 *
 * @param patch 需要覆写的字段
 * @returns 完整配置（name 恒有值，避免每条用例都重复写）
 */
function config(patch: Partial<McpServerConfig>): McpServerConfig {
  return { name: 'srv', ...patch };
}

describe('resolveTransportMode（缺省值单点）', () => {
  it('缺省 / null ⇒ stdio（老配置零迁移）', () => {
    expect(resolveTransportMode(undefined)).toBe('stdio');
    expect(resolveTransportMode(null)).toBe('stdio');
  });

  it('合法值原样返回；未知值（含 sse）返回 null 交给 configProblem 给文案', () => {
    expect(resolveTransportMode('stdio')).toBe('stdio');
    expect(resolveTransportMode('http')).toBe('http');
    expect(resolveTransportMode('sse')).toBeNull();
    expect(resolveTransportMode('HTTP')).toBeNull();
    expect(resolveTransportMode(42)).toBeNull();
  });
});

describe('configProblem：形态无关的护栏', () => {
  it('缺 name ⇒ 「缺少 name」', () => {
    expect(configProblem({ name: '   ', command: 'node' })).toBe('缺少 name');
  });

  it('手写 type ⇒ 指路 transport（本仓不认别名，别名只在导入通道映射一次）', () => {
    // `type` 刻意不在 DTO 上（写上来就是用户手改 settings.json 的形态）⇒ 只能经 unknown 造夹具
    const handWritten = {
      ...config({ command: 'node' }),
      type: 'stdio',
    } as unknown as McpServerConfig;
    const problem = configProblem(handWritten);
    expect(problem).toContain('未知字段 type');
    expect(problem).toContain('transport');
  });

  it('未知 transport 值 ⇒ 报原值，不退化成通用语法错误', () => {
    const problem = configProblem(config({ command: 'node', transport: 'websocket' as never }));
    expect(problem).toContain('未知的 transport 值');
    expect(problem).toContain('websocket');
  });

  it('transport: sse ⇒ 点名「已定案不做」并指路 http', () => {
    const problem = configProblem(config({ command: 'node', transport: 'sse' as never }));
    expect(problem).toContain('SSE');
    expect(problem).toContain('已定案不做');
    expect(problem).toContain('http');
  });
});

describe('configProblem：stdio 形态（缺省）', () => {
  it('缺 command ⇒ 「缺少 command」', () => {
    expect(configProblem(config({ command: '  ' }))).toBe('缺少 command');
    expect(configProblem(config({}))).toBe('缺少 command');
  });

  it('合法 stdio 配置 ⇒ null', () => {
    expect(configProblem(config({ command: 'npx', args: ['-y', 'pkg'] }))).toBeNull();
  });

  it('反向护栏：stdio 填 url ⇒ 报互斥并指路 transport: "http"', () => {
    const problem = configProblem(config({ command: 'node', url: 'https://x/mcp' }));
    expect(problem).toContain('stdio 配置不能填写 url');
    expect(problem).toContain('transport: "http"');
  });

  it('反向护栏：stdio 填 headers ⇒ 报「只对 http 生效」', () => {
    const problem = configProblem(config({ command: 'node', headers: { A: 'b' } }));
    expect(problem).toContain('不支持 headers');
    expect(problem).toContain('http');
  });
});

describe('configProblem：http 形态', () => {
  it('合法远程配置 ⇒ null（含 headers）', () => {
    expect(
      configProblem(
        config({ transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } }),
      ),
    ).toBeNull();
  });

  it('缺 url / url 非法 ⇒ 各自点名（不是笼统「配置不完整」）', () => {
    expect(configProblem(config({ transport: 'http' }))).toContain('缺少 url');
    expect(configProblem(config({ transport: 'http', url: 'not a url' }))).toContain(
      'url 不是合法地址',
    );
  });

  it('协议只认 http/https', () => {
    const problem = configProblem(config({ transport: 'http', url: 'ftp://x/mcp' }));
    expect(problem).toContain('只支持 http / https');
    expect(problem).toContain('ftp:');
  });

  it('非回环地址强制 https（明文会让工具参数与结果整段暴露）', () => {
    const problem = configProblem(config({ transport: 'http', url: 'http://example.com/mcp' }));
    expect(problem).toContain('必须使用 https');
  });

  it('回环地址允许 http（本地网关调试）', () => {
    expect(
      configProblem(config({ transport: 'http', url: 'http://127.0.0.1:3000/mcp' })),
    ).toBeNull();
    expect(configProblem(config({ transport: 'http', url: 'http://localhost/mcp' }))).toBeNull();
    expect(configProblem(config({ transport: 'http', url: 'http://[::1]/mcp' }))).toBeNull();
  });

  it('互斥：http 填 command / args / cwd / env ⇒ 逐项报「不能填写」（不静默忽略）', () => {
    const base = { transport: 'http' as const, url: 'https://x/mcp' };
    expect(configProblem(config({ ...base, command: 'node' }))).toContain('不能填写 command');
    expect(configProblem(config({ ...base, args: ['x'] }))).toContain('不能填写 args');
    expect(configProblem(config({ ...base, cwd: '/tmp' }))).toContain('不能填写 cwd');
    expect(configProblem(config({ ...base, env: { A: '1' } }))).toContain('不能填写 env');
  });

  it('空值不算「填了」：args: [] / env: {} / cwd: "" 不报互斥（表单产出的噪音）', () => {
    expect(
      configProblem(
        config({ transport: 'http', url: 'https://x/mcp', args: [], env: {}, cwd: '' }),
      ),
    ).toBeNull();
  });
});

describe('configProblem：headers 形态（运行期唯一校验点）', () => {
  it('非对象 / 数组 ⇒ 报形态错误', () => {
    expect(
      configProblem(config({ transport: 'http', url: 'https://x/mcp', headers: 'x' as never })),
    ).toContain('必须是');
    expect(
      configProblem(config({ transport: 'http', url: 'https://x/mcp', headers: [] as never })),
    ).toContain('必须是');
  });

  it('值不是字符串 ⇒ 点名该键（不静默 ASCII 化）', () => {
    const problem = configProblem(
      config({ transport: 'http', url: 'https://x/mcp', headers: { A: 1 as never } }),
    );
    expect(problem).toContain('值必须是字符串');
    expect(problem).toContain('A');
  });

  it('键或值含 CR/LF ⇒ 拒绝（头拆分注入）', () => {
    expect(
      configProblem(
        config({ transport: 'http', url: 'https://x/mcp', headers: { 'A\r\nB': 'v' } }),
      ),
    ).toContain('不能包含换行');
    expect(
      configProblem(config({ transport: 'http', url: 'https://x/mcp', headers: { A: 'v\nB' } })),
    ).toContain('不能包含换行');
  });
});
