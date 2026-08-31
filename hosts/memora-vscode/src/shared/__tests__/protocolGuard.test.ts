/**
 * 协议消息类型计数守卫（V-1，2026-08-31）
 *
 * 治理背景：VSCode 宿主没有 memora-sprite 那样的运行时 IPC 通道注册表（ipcMain 通道），
 * 其「IPC 通道」实际 = shared/protocol.ts 中 WebviewToExtensionMessage + ExtensionToWebviewMessage
 * 两个联合类型的消息类型（type 字面量）——webview 与 extension 两侧需为每个 type 实现
 * postMessage 投递 + 监听分发，属真实可度量、可治理的通信通道。
 *
 * 守卫语义（最低成本护栏，对齐 project-rules.md「IPC 通道接近阈值时启动治理评估」）：
 * 统计 protocol.ts 中全部去重消息类型数，达到阈值即测试失败，促使治理评估——
 * 而非靠文档/记忆自觉（换人换会话易静默越线）。
 *
 * 口径说明：
 *   - 仅统计联合类型中的 `type: '...'` 字面量（去重：同名消息类型 W→E 与 E→W 共用一条通道，
 *     如 skills_read_content 双向同名，按 1 条计）；
 *   - 排除 MESSAGE_TYPES 历史常量表——其与联合类型不同步，非真实通道定义（含已废弃的
 *     response_complete 等残留），统计它会把死键当通道虚增计数。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** IPC 消息类型治理阈值（对齐用户口径：达 130 启动治理评估；sprite 侧亦从 150 收紧至 130） */
const IPC_CHANNEL_GOVERNANCE_THRESHOLD = 130;

/** 从 protocol.ts 源码提取去重消息类型集合（过滤注释，仅统计 `type: '...'` 字面量） */
function extractMessageTypes(source: string): Set<string> {
  // 去块注释（/** ... */）：联合类型注释中可能出现 type 字样，须先剥离防误计
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // 去行注释（// ...）：同上，防注释内 type: 'xxx' 误计
  const noComments = noBlockComments.replace(/\/\/[^\n]*/g, '');
  // 匹配联合类型成员中的 type 字面量（MESSAGE_TYPES 常量表为 KEY: 'value' 形式，无 type: 前缀，天然排除）
  const types = new Set<string>();
  const re = /type:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    types.add(m[1]);
  }
  return types;
}

describe('协议消息类型计数守卫（V-1）', () => {
  it('protocol.ts 消息类型总数应低于治理阈值（达阈值即失败，提示启动治理评估）', () => {
    // 读取协议单一真理源源码（与运行时同一文件，非复制品，避免守卫自身漂移）
    const source = readFileSync(join(__dirname, '../protocol.ts'), 'utf-8');
    const types = extractMessageTypes(source);
    const count = types.size;
    expect(
      count,
      `协议消息类型已达 ${count} 条（阈值 ${IPC_CHANNEL_GOVERNANCE_THRESHOLD}），需启动通道合并/收敛治理评估`,
    ).toBeLessThan(IPC_CHANNEL_GOVERNANCE_THRESHOLD);
  });
});
