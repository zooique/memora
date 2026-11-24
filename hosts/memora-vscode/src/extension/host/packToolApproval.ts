/**
 * 角色包专属工具批准同步（宿主侧唯一实现）
 *
 * 为什么单独成模块：配置读取、装配期注入、配置变更监听、批准命令四处**共用同一份读取与写入实现**。
 * 若各自内联 `getConfiguration('memora')`，键名/默认值/形状校验会在四处各存一份，改一处漏三处
 * （与 `host/skillSync.ts` 同一纪律）。
 *
 * 三层职责划分（勿折叠）：
 *   - 宿主只负责「把用户批准的记录读出来 / 写回去」，**不做注册裁决**；
 *   - 是否真的注册给模型由内核按「包名 + 工具名 + 脚本 hash」三键匹配决定
 *     （`Agent.setRolePackToolApprovals`，内核是唯一裁决处）；
 *   - 命令层只做「列出待批准项 + 写回配置」两件事。
 */
import * as vscode from 'vscode';
import type { Agent, RolePackToolApproval } from '@zooique/memora';

/** 配置节（与其余 memora 配置同源） */
const CONFIG_SECTION = 'memora';
/** 配置键：已批准的角色包工具记录 */
const CONFIG_KEY = 'approvedPackTools';

/**
 * 读取「已批准的角色包工具」配置（**唯一读取点**）
 *
 * 对配置做形状校验：配置可被用户手改，畸形条目（缺字段 / 非字符串 / 空串）一律丢弃并告警，
 * **不抛错**——一条坏记录不能让整个扩展装配失败。丢弃后内核自然按「未批准」处理（fail-closed）。
 *
 * @returns 形状合法的批准记录（可能为空数组）
 */
export function readApprovedPackTools(): RolePackToolApproval[] {
  const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown[]>(CONFIG_KEY, []);

  /** 形状合法的批准记录（逐条过滤后累积） */
  const result: RolePackToolApproval[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const packName = record['packName'];
    const toolName = record['toolName'];
    const scriptHash = record['scriptHash'];
    // 三键缺一或类型不对 ⇒ 该条记录无法参与匹配，直接丢弃（不留半条）
    if (
      typeof packName !== 'string' ||
      typeof toolName !== 'string' ||
      typeof scriptHash !== 'string' ||
      !packName ||
      !toolName ||
      !scriptHash
    ) {
      console.warn('Memora 角色包工具批准记录形状不合法，已忽略该条', entry);
      continue;
    }
    result.push({ packName, toolName, scriptHash });
  }
  return result;
}

/**
 * 把批准记录同步给内核（装配期注入 + 运行期刷新共用）
 *
 * 内核侧 `setRolePackToolApprovals` 为纯内存重放（清旧 + 按批准集注册），幂等、无 IO，
 * 故可安全重复调用。
 *
 * @param agent 已装配的 Agent
 */
export function syncPackToolApprovals(agent: Agent): void {
  // 每次重读配置：调用点既有「用户刚改配置」也有「装配期注入」，读缓存会让后者拿到旧值
  agent.setRolePackToolApprovals(readApprovedPackTools());
}

/**
 * 写回批准记录（批准命令的唯一写入点）
 *
 * 写用户级（`ConfigurationTarget.Global`）：项目级配置可由他人提交，静默把第三方脚本授予模型，
 * 故本项目强制用户级（与 `memora.disabledSkills` 同口径）。
 *
 * @param approvals 完整批准集合（调用方负责「保留其它包 + 替换本包」的合并语义）
 */
export async function writeApprovedPackTools(
  approvals: readonly RolePackToolApproval[],
): Promise<void> {
  // 只落三键，避免把调用方的额外字段写进用户设置
  const plain = approvals.map((a) => ({
    packName: a.packName,
    toolName: a.toolName,
    scriptHash: a.scriptHash,
  }));
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(CONFIG_KEY, plain, vscode.ConfigurationTarget.Global);
}
