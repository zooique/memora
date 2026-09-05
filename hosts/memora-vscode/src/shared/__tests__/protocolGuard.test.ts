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

// ──────────────────────────────────────────────────────────────
// V-2：Agent 事件宿主消费对账守卫（2026-09-05）
//
// 治理背景：eventEmitter.ts 的 AGENT_EVENTS 是内核→宿主广播事件的真理源。
// 宿主 chatPanel.ts + settingsPanel.ts 必须为每个事件提供消费入口（handler 可以
// 只做 info/error toast，但必须 on 订阅，防止事件"发了没人听"静默堆积）。
//
// 守卫语义：提取 AGENT_EVENTS 键集（真理源），与宿主 `.on('xxx')` 消费求差集，
// 差集非空即失败——新增事件时强制同步宿主订阅，防止再出现 goalUpdated 发两年
// 宿主才清的情况。
//
// 排除规则：只检查 agent 事件（与 AGENT_EVENTS 键集求交集自动排除 Node 原生
// 事件 close/data/error 等），宿主其他文件的 `.on` 不纳入对账范围。
// ──────────────────────────────────────────────────────────────

/** eventEmitter.ts 路径（__dirname → shared → src → memora-vscode → hosts → 项目根 → src/utils） */
const EVENT_EMITTER_PATH = join(__dirname, '../../../../../src/utils/eventEmitter.ts');
/** chatPanel.ts 路径（__dirname → shared → src → webview/panels） */
const CHAT_PANEL_PATH = join(__dirname, '../../webview/panels/chatPanel.ts');
/** settingsPanel.ts 路径（同上） */
const SETTINGS_PANEL_PATH = join(__dirname, '../../webview/panels/settingsPanel.ts');

/**
 * 从 eventEmitter.ts 源码提取 AGENT_EVENTS 键集（真理源）
 * 先切片出 AGENT_EVENTS = { ... } 块，再剥注释、匹配 `  key: 'value'` 键行
 */
function extractAgentEventKeys(source: string): Set<string> {
  // 切片 AGENT_EVENTS = { ... } 块（end 用 `} as const;` 锚定，避免匹配后面的 AgentEventMap 接口）
  const blockStart = source.indexOf('AGENT_EVENTS = {');
  const blockEnd = source.indexOf('} as const;');
  if (blockStart < 0 || blockEnd < 0) {
    throw new Error('无法定位 AGENT_EVENTS 块（eventEmitter.ts 结构可能已变）');
  }
  const block = source.slice(blockStart, blockEnd);
  // 去块注释
  const noBlockComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  // 去行注释
  const noComments = noBlockComments.replace(/\/\/[^\n]*/g, '');
  const keys = new Set<string>();
  // 匹配块内 `  eventName: 'eventName',` 形式键（AGENT_EVENTS 块内无接口属性，不会误计 target/level 等）
  const re = /^\s+(\w+):\s*'/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

/**
 * 从宿主文件源码提取事件消费名（.on / .once，排除注释）
 * 同时读取 chatPanel + settingsPanel 两个宿主核心消费入口
 */
function extractHostConsumedEvents(filePaths: string[]): Set<string> {
  const consumed = new Set<string>();
  for (const filePath of filePaths) {
    const source = readFileSync(filePath, 'utf-8');
    // 去注释防止注释内的 .on('xxx') 被误计
    const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const noComments = noBlockComments.replace(/\/\/[^\n]*/g, '');
    // 同时匹配 .on 和 .once（TypedEventEmitter 两种订阅方法）
    const re = /\.(?:on|once)\(['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(noComments)) !== null) {
      consumed.add(m[1]);
    }
  }
  return consumed;
}

describe('Agent 事件宿主消费对账守卫（V-2）', () => {
  it('AGENT_EVENTS 全部事件应有宿主消费入口（chatPanel + settingsPanel 至少一处 on 订阅）', () => {
    // 真理源：内核事件定义
    const eventEmitterSource = readFileSync(EVENT_EMITTER_PATH, 'utf-8');
    const allEvents = extractAgentEventKeys(eventEmitterSource);

    // 宿主消费：chatPanel + settingsPanel 两个核心入口
    const consumedFromHost = extractHostConsumedEvents([CHAT_PANEL_PATH, SETTINGS_PANEL_PATH]);

    // 求交集得到宿主消费的 agent 事件名（自动排除 Node 原生事件 close/data/error 等）
    const consumedAgentEvents = new Set<string>();
    for (const name of consumedFromHost) {
      if (allEvents.has(name)) consumedAgentEvents.add(name);
    }

    // 差集：真理源有但宿主没消费的事件
    const missingConsumption: string[] = [];
    for (const event of allEvents) {
      if (!consumedAgentEvents.has(event)) {
        missingConsumption.push(event);
      }
    }

    expect(
      missingConsumption,
      `以下 Agent 事件定义在 eventEmitter.ts 中但宿主未消费（chatPanel + settingsPanel 均无 on 订阅）：[${missingConsumption.join(', ')}]。新增事件时需同步宿主订阅入口。`,
    ).toEqual([]);
  });
});
