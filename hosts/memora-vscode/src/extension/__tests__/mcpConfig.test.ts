/**
 * MCP 配置读取点（`readMcpServers` / `readMcpToolAllowlist`）的形态收窄
 *
 * 为什么必须守：这两个函数是**唯一读取点**，消费方有三个（装配、配置热更、设置面板状态
 * 推送）。收窄若放错地方，症状是「装配侧拦住了、面板侧没拦住」——用户把一个合法 JSON
 * 但形状不对的值（把 `mcpServers` 写成对象）存进去，设置页会卡在「加载中…」，且只在
 * 真机表现（2026-10-24 全量跑批两条红即此：`configured is not iterable`）。
 *
 * 断言口径 = 返回值形态，不是实现细节：任何非法输入都必须收敛成空数组/空集，不抛。
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** 可编程的配置读面（每例只改 `value`） */
const state: { value: unknown } = { value: undefined };

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      // 模拟 VS Code 的 get(key, fallback)：键未设置时给 fallback，设置了就原样返回
      get: (_key: string, fallback: unknown) =>
        state.value === undefined ? fallback : state.value,
    }),
  },
}));

const { readMcpServers, readMcpToolAllowlist } = await import('../mcpConfig.js');
// 对拍用：形态集合真源（shared）+ 缺省解析（宿主判据）。两者都是纯函数 / 常量，无 vscode 依赖。
import { MCP_TRANSPORTS } from '../../shared/protocol.js';
import { resolveTransportMode } from '../host/mcp/mcpConfigGuard.js';

describe('readMcpServers（配置数组的形态收窄）', () => {
  beforeEach(() => {
    state.value = undefined;
  });

  it('缺省（undefined）⇒ 空数组（本函数不抛）', () => {
    expect(readMcpServers()).toEqual([]);
  });

  it('非数组（用户把对象写成值）⇒ 空数组，不抛', () => {
    state.value = { name: 'fs', command: 'npx' };
    expect(readMcpServers()).toEqual([]);
  });

  it('数组原样返回（含本仓不认识的字段，读取点不做字段裁剪）', () => {
    const value = [{ name: 'fs', command: 'npx', futureField: 1 }];
    state.value = value;
    expect(readMcpServers()).toEqual(value);
  });
});

describe('readMcpToolAllowlist（同一收窄口径）', () => {
  beforeEach(() => {
    state.value = undefined;
  });

  it('缺省 / 非数组 ⇒ 空数组（空集 ⇒ 全部每次确认，fail-closed 方向不变）', () => {
    expect(readMcpToolAllowlist()).toEqual([]);
    state.value = 'mcp__fs__read_file';
    expect(readMcpToolAllowlist()).toEqual([]);
  });

  it('数组原样返回', () => {
    state.value = ['mcp__fs__read_file'];
    expect(readMcpToolAllowlist()).toEqual(['mcp__fs__read_file']);
  });
});

/**
 * `scope: "machine"` ↔「只认用户级 + 不随设置同步」的**结构机制**（2026-10-25 定案 · 方案 §4.4 拍板 2 / §6 R7）
 *
 * 为什么必须守：本仓拒绝工作区级 `.mcp.json`（他人提交的配置 = 在用户机器上自动拉起
 * 任意命令），但实现手段**不在代码里**——没有一处 `if` 判断配置来自哪一级，靠的是
 * package.json 把两个键声明为 `scope: "machine"`（VS Code 只允许用户 / 远程设置写入，
 * 工作区 / 文件夹写入被忽略）。于是**删掉该字段（缺省为 window）或改成
 * `machine-overridable`**，零编译错、零测试红，工作区级配置就静默生效了——正是
 * 「闸门有实现 ≠ 会跑」。
 *
 * 为什么是 `machine` 而非 `application`（2026-10-25 拍板）：两者都只写用户设置；差别在
 * Settings Sync——`application` 会随账号把 `headers` 明文令牌与 allowlist 批准同步到其他
 * 设备（= 替 B 机点同意，授权单源被打破），`machine` 不参与同步。代价 = 每台机器各配一次。
 * 判据见方案 §6 R7、台账「宿主 0.3.0 · H0-2」。
 *
 * 反向自检：把任一键的 scope 改成 `machine-overridable` 或删掉 ⇒ 本例红。
 */
describe('package.json#contributes.configuration 的 scope ↔ 只认用户级', () => {
  type Prop = {
    scope?: string;
    default?: unknown;
    /** mcpServers 是数组 ⇒ 条目 schema 在 items.properties 里 */
    items?: { properties?: Record<string, { enum?: readonly string[]; default?: unknown }> };
  };
  const pkg = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { contributes: { configuration: { properties: Record<string, Prop> } } };
  const props = pkg.contributes.configuration.properties;

  it('两个 MCP 配置键均声明 scope: machine（工作区级写入被忽略、不随 Settings Sync 同步）', () => {
    expect(props['memora.mcpServers']?.scope).toBe('machine');
    expect(props['memora.mcpToolAllowlist']?.scope).toBe('machine');
  });

  it('allowlist 默认空集（未配置 ⇒ 逐条确认，fail-closed 不靠运行时兜底）', () => {
    expect(props['memora.mcpToolAllowlist']?.default).toEqual([]);
  });

  /**
   * `transport` 的 enum / default ↔ **代码真源**的对拍
   *
   * 为什么必须守：`enum` 是 VS Code 设置界面渲染下拉的源，代码侧的取值集合是
   * `MCP_TRANSPORTS`——**同一语义两个真源**，而 JSON 引不到 TS，删/加一个形态时
   * 零编译错、零测试红（用户能在下拉里选到一个跑不起来的形态，或反过来选不到）。
   * `default` 同理：设置界面的默认值必须与「不写 transport」的解析结果一致
   * （`resolveTransportMode(undefined)` = stdio），否则「同一份配置两处缺省不同」。
   */
  it('transport 的 enum ≡ MCP_TRANSPORTS，default ≡ 缺省解析结果', () => {
    const spec = props['memora.mcpServers']?.items?.properties?.transport;
    expect(spec?.enum).toEqual([...MCP_TRANSPORTS]);
    expect(spec?.default).toBe(resolveTransportMode(undefined));
  });
});
