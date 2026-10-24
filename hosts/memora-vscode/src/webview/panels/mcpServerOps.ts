/**
 * MCP 写操作（`mcp_write` 六个 op 的**唯一实现**）
 *
 * 为什么独立成文件而不是塞进 settingsPanel：
 *   ① settingsPanel 是贴 eslint max-lines 上限的 TARGET 文件（只降不升），而本域还要随
 *      功能长（表单校验、竞态、回执都是线性增长域）；
 *   ② 这六个 op 是**同一个语义面**（MCP 配置写入），放一处才能保证「写入路径只有一条」。
 *      `connect` 是唯一的例外形态：它不改配置，只触发宿主装配（pending 的唯一出路，
 *      见 protocol 里该 op 的说明）——仍归此处，因为「卡片上的按钮按下去要有回执」这条
 *      约定与其余五个共用同一份 notice/pushStatus 收口。
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
import { configProblem, normalizeServerName } from '../../extension/host/mcp/mcpConfigGuard.js';
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
  /**
   * 触发宿主装配（`pending` 态的唯一出路）
   *
   * 不带 name：装配是**全局**动作（一次装配按当前配置拉起所有台），拿 name 只会让本模块
   * 误以为它是按台操作。回执文案由本模块拼（它知道用户点的是哪张卡）。
   * 注入实现必须复用对话面板同一个 agent 单例（`getOrCreateAgent`），否则会出现第二个
   * MCP 运行时 —— 两台同时注册同名工具。
   */
  connect(): Promise<{ ok: boolean; error?: string }>;
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
 * **三个可清空字段（args / env / cwd）恒写**，空值由 {@link clearEmptyFields} 在合并后删除。
 *
 * 为什么不能「空就不写」（2026-10-24 修的缺陷）：`upsert` 用 `{...old, ...patch}` 合并，
 * 表单不发的字段等于「保持旧值」——于是用户在表单里**清空参数**再保存，旧参数会原样复活，
 * 而 UI 回推又显示旧值，用户以为保存失败。保护未知字段（不带伤）与保护用户明确删除的数据
 * 是两件事，必须分开：`args: []` 是「我删了」，`args` 缺省才是「我不知道这个字段」。
 *
 * **name 走 `normalizeServerName` 归一化后再落盘**：这是唯一写入点，一次归一化就让
 * 「落盘值 / 运行态键 / 面板显示」三处同名（否则 `"fs "` 会一路散点，见该函数的说明）。
 * 用户看到的就是 `fs`，写回 `fs` 不构成静默改写。
 *
 * @param draft 表单草稿
 */
function draftToConfig(draft: McpServerDraftDto): McpServerConfig {
  return {
    name: normalizeServerName(draft.name),
    command: draft.command,
    enabled: draft.enabled !== false,
    args: Array.isArray(draft.args) ? [...draft.args] : [],
    env: draft.env && typeof draft.env === 'object' ? { ...draft.env } : {},
    cwd: typeof draft.cwd === 'string' ? draft.cwd : '',
  };
}

/**
 * 删掉空值字段（落盘前归一化）
 *
 * 目的：用户清空生效的同时，配置里不留 `args: []` / `cwd: ""` 这类噪音（它们与缺省等价，
 * 却会让 `configsEqual` 的稳定序列化把「清空」判成「配置变了」而触发一次不必要的重启）。
 *
 * @param config 合并后的配置（原地删除，调用方保证是新建对象）
 * @returns 同一对象（便于链式）
 */
function clearEmptyFields(config: McpServerConfig): McpServerConfig {
  if (!config.args || config.args.length === 0) delete config.args;
  if (!config.env || Object.keys(config.env).length === 0) delete config.env;
  if (!config.cwd) delete config.cwd;
  return config;
}

/**
 * 执行一条 `mcp_write`（六个 op 的唯一入口）
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
    case 'connect': {
      // 成功**刻意静默**（与 restart 同口径）：卡片状态自己会走到 running / failed，
      // 失败原因由状态面逐字显示，再弹一条 toast 就是同一件事说两遍。
      const result = await deps.connect();
      if (!result.ok)
        deps.notice('error', `接入「${payload.name}」失败：${result.error ?? '未知原因'}`);
      // 装配完成 ⇒ 状态从 pending 变成 running/failed；装配失败 ⇒ 仍是 pending，
      // 两种情况都必须回推，否则面板停在用户点按钮之前的那一帧。
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
 * （将来新增的 `timeout`/`headers` 等）原样保留，不会被编辑动作冲掉；而表单**认识**的三个
 * 可清空字段（args / env / cwd）是全量覆盖——空值即删除，否则用户清空后旧值会复活。
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
  // 按归一化名定位（配置里可能有 `"fs "`，面板下发的一定是 `fs`）——否则编辑会**追加**一条
  // 同名近似项，而运行侧按先到先得跳过它 ⇒ 用户「保存了但没生效」
  const index = configs.findIndex((item) => normalizeServerName(item.name) === patch.name);
  // 展开合并：保留旧项里表单不认识的键（不带伤——编辑动作不销毁未知字段）；
  // 表单认识的三个可清空字段由 patch 全量覆盖 ⇒ 空值即删除（见 clearEmptyFields）
  const merged: McpServerConfig = index >= 0 ? { ...configs[index], ...patch } : { ...patch };
  clearEmptyFields(merged);

  // 判据与启动侧同源（mcpConfigGuard.configProblem）：面板能存进去的配置，启动侧不会因同一原因拒
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
  // 归一化比较：面板下发的名来自状态面（已归一化），配置原值可能带首尾空白。
  // 直接 `!==` 会「删不掉」并回执「未找到」（实测缺陷）。
  const target = normalizeServerName(name);
  const next = configs.filter((item) => normalizeServerName(item.name) !== target);
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
  const target = normalizeServerName(name);
  const index = configs.findIndex((item) => normalizeServerName(item.name) === target);
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
