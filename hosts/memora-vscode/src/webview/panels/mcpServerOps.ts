/**
 * MCP 写操作（`mcp_write` 五个 op 的**唯一实现**）
 *
 * 为什么独立成文件而不是塞进 settingsPanel：
 *   ① settingsPanel 是贴 eslint max-lines 上限的 TARGET 文件（只降不升），而本域还要随
 *      功能长（表单校验、竞态、回执都是线性增长域）；
 *   ② 这五个 op 是**同一个语义面**（MCP 配置写入），放一处才能保证「写入路径只有一条」。
 *
 * 三条纪律（SSOT / 不带伤）：
 *   1. **单一写入路径**：所有改配置的 op 都经 {@link writeServers}（`getConfiguration().update`
 *      + ConfigurationTarget.Global）。不新建第二条生效路径——写完由既有
 *      onDidChangeConfiguration 热更链生效。
 *   2. **写入前重读配置**：`upsert` / `remove` / `setEnabled` 都是整数组覆盖，若用「打开表单时的
 *      快照」做基底，用户在编辑期间手改 settings.json 的改动会被静默冲掉。这里每次写前重读一次，
 *      把窗口从「人编辑的分钟级」压到「毫秒级」；残留窗口如实登记在台账（读-写非原子）。
 *   3. **失败必须有声音**：写失败 / 校验失败一律 `notice('error', …)` 并回推状态（让面板收敛到
 *      持久化真值）。首版的静默 unhandled rejection 是缺陷，不是风格。
 */
import * as vscode from 'vscode';
import {
  MCP_ALLOWLIST_KEY,
  MCP_SERVERS_KEY,
  readMcpServers,
  readMcpToolAllowlist,
} from '../../extension/mcpConfig.js';
import { configProblem } from '../../extension/host/mcp/runtime.js';
import type { McpServerConfig } from '../../extension/host/mcp/connectionManager.js';
import type { McpServerDraftDto, McpWritePayload } from '../../shared/protocol.js';

/**
 * 写操作依赖（由 settingsPanel 注入：它持有视图、agent 与日志）
 */
export interface McpOpsDeps {
  /** 回推 MCP 状态（真源 = runtime.getMcpServerStatus） */
  pushStatus(): void;
  /** 操作回执（走既有 notice 通道，设置页顶部 toast） */
  notice(level: 'info' | 'error', message: string): void;
  /** 重启单台（由 panel 注入：需要已装配的 agent；未装配给失败回执，不懒装配） */
  restart(name: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * 读取当前配置（写入前的基线）
 *
 * 键名与「是不是数组」的收窄都在 `readMcpServers` 单点，这里只多一步**元素**收窄：
 * 数组里混进 `null` 之类的非对象项时，展开合并会炸在 `{...null}` 之外的地方。
 */
function readServers(): McpServerConfig[] {
  return readMcpServers().filter(
    (item): item is McpServerConfig => typeof item === 'object' && item !== null,
  );
}

/**
 * 写配置（唯一写入路径 + 唯一失败收口）
 *
 * @param deps 依赖（失败要回执）
 * @param next 完整数组（**不是差量**：`update` 是整键覆盖）
 * @returns 是否写入成功
 */
async function writeServers(deps: McpOpsDeps, next: McpServerConfig[]): Promise<boolean> {
  try {
    await vscode.workspace
      .getConfiguration('memora')
      .update(MCP_SERVERS_KEY, next, vscode.ConfigurationTarget.Global);
    return true;
  } catch (err) {
    deps.notice('error', `MCP 配置写入失败：${String(err)}`);
    return false;
  }
}

/**
 * 把表单草稿收敛成可落盘的配置项
 *
 * **只收敛「用户明确表达的字段」**：`args/env/cwd` 为空则不写（保持配置干净），
 * `enabled` 恒写（它承载「停用」这个显式意图，缺省碰运气不如写明）。
 * 未知字段由调用方 `{...old, ...patch}` 保留，本函数不碰。
 *
 * @param draft 表单草稿
 */
function draftToConfig(draft: McpServerDraftDto): McpServerConfig {
  const config: McpServerConfig = {
    name: draft.name,
    command: draft.command,
    enabled: draft.enabled !== false,
  };
  if (Array.isArray(draft.args) && draft.args.length > 0) config.args = [...draft.args];
  if (draft.env && Object.keys(draft.env).length > 0) config.env = { ...draft.env };
  if (typeof draft.cwd === 'string' && draft.cwd.length > 0) config.cwd = draft.cwd;
  return config;
}

/**
 * 执行一条 `mcp_write`（五个 op 的唯一入口）
 *
 * 每个 op 结束都 `pushStatus()`：写配置的 op 写完立刻推一次（未装配时热更不跑，不推会停在
 * 旧值），热更生效后 extension 再推一次覆盖 —— 两次推送幂等，不构成第二份状态真源。
 *
 * @param deps 依赖
 * @param payload 消息载荷（op 判别联合）
 */
export async function applyMcpWrite(deps: McpOpsDeps, payload: McpWritePayload): Promise<void> {
  switch (payload.op) {
    case 'allow':
      await setAllowlisted(deps, payload.key, payload.allowlisted);
      return;
    case 'upsert':
      await upsertServer(deps, payload.server);
      return;
    case 'remove':
      await removeServer(deps, payload.name);
      return;
    case 'setEnabled':
      await setServerEnabled(deps, payload.name, payload.enabled);
      return;
    case 'restart': {
      const result = await deps.restart(payload.name);
      if (!result.ok)
        deps.notice('error', `重启「${payload.name}」失败：${result.error ?? '未知原因'}`);
      deps.pushStatus();
      return;
    }
  }
}

/**
 * 切换单个工具的免确认档位
 *
 * 键由 host 下发的 `allowKey` 原样回传（webview 不构造），本函数**不重算、不校验格式**——
 * 校验在 `policy.parseAllowlist`（fail-closed）里，重复一遍判据就是散点。
 *
 * @param deps 依赖
 * @param key 免确认寻址键
 * @param allowlisted true=加入免确认
 */
async function setAllowlisted(deps: McpOpsDeps, key: string, allowlisted: boolean): Promise<void> {
  const kept = readMcpToolAllowlist().filter((item) => typeof item === 'string' && item.length > 0);
  const next = new Set(kept);
  if (allowlisted) next.add(key);
  else next.delete(key);
  try {
    await vscode.workspace
      .getConfiguration('memora')
      .update(MCP_ALLOWLIST_KEY, [...next], vscode.ConfigurationTarget.Global);
  } catch (err) {
    // 写不进去必须说：webview 已把勾选还原，沉默会让用户以为「点了没反应」
    deps.notice('error', `免确认设置写入失败：${String(err)}`);
  }
  deps.pushStatus();
}

/**
 * 新增或更新一台 server
 *
 * **按 name 定位**：name 同时是工具名前缀与 allowlist 寻址键，所以它是身份而不是可编辑字段
 * （改名 = 删除后重建，见 `mcpView` 的表单只读锁）。`{...old, ...patch}` ⇒ 表单不认识的字段
 * （将来新增的 `timeout`/`headers` 等）原样保留，不会被编辑动作冲掉。
 *
 * @param deps 依赖
 * @param draft 表单草稿
 */
async function upsertServer(deps: McpOpsDeps, draft: McpServerDraftDto): Promise<void> {
  if (!draft || typeof draft.name !== 'string') {
    deps.notice('error', 'MCP 服务器保存失败：缺少名称');
    return;
  }
  const configs = readServers();
  const patch = draftToConfig(draft);
  const index = configs.findIndex((item) => item.name === patch.name);
  // 展开合并：保留旧项里表单不认识的键（不带伤——编辑动作不销毁未知字段）
  const merged: McpServerConfig = index >= 0 ? { ...configs[index], ...patch } : patch;

  // 判据与启动侧同源（runtime.configProblem）：面板能存进去的配置，启动侧不会因同一原因拒
  const problem = configProblem(merged);
  if (problem) {
    deps.notice('error', `MCP 服务器「${merged.name || '(未命名)'}」不可保存：${problem}`);
    deps.pushStatus();
    return;
  }

  if (index >= 0) configs[index] = merged;
  else configs.push(merged);

  if (await writeServers(deps, configs)) {
    deps.notice('info', index >= 0 ? `已更新「${merged.name}」` : `已添加「${merged.name}」`);
  }
  deps.pushStatus();
}

/**
 * 删除一台 server（按 name）
 *
 * **不联动清 allowlist**：那是用户逐条授予的信任记录，删一台 server 不该顺带抹掉；
 * 残留键指向不存在的 server 无害（parseAllowlist 只用于匹配，不校验存在性），
 * 重新添加同名 server 时档位自动恢复。
 *
 * @param deps 依赖
 * @param name server 名
 */
async function removeServer(deps: McpOpsDeps, name: string): Promise<void> {
  const configs = readServers();
  const next = configs.filter((item) => item.name !== name);
  if (next.length === configs.length) {
    deps.notice('error', `未找到 server「${name}」（配置可能已被其他窗口修改）`);
  } else if (await writeServers(deps, next)) {
    deps.notice('info', `已删除「${name}」`);
  }
  deps.pushStatus();
}

/**
 * 启用 / 停用一台 server（可撤销，等价于「不拉起」，不是删除）
 *
 * @param deps 依赖
 * @param name server 名
 * @param enabled 目标启用位
 */
async function setServerEnabled(deps: McpOpsDeps, name: string, enabled: boolean): Promise<void> {
  const configs = readServers();
  const index = configs.findIndex((item) => item.name === name);
  if (index < 0) {
    deps.notice('error', `未找到 server「${name}」（配置可能已被其他窗口修改）`);
    deps.pushStatus();
    return;
  }
  configs[index] = { ...configs[index], enabled };
  if (await writeServers(deps, configs)) {
    deps.notice('info', enabled ? `已启用「${name}」` : `已停用「${name}」`);
  }
  deps.pushStatus();
}
