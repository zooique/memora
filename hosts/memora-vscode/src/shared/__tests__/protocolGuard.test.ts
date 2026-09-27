/**
 * 协议消息类型计数守卫
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
 *   - 联合类型是消息类型唯一权威源——无 MESSAGE_TYPES 运行时镜像表（镜像表会与联合类型
 *     长期不同步、成纯僵尸镜像，统计只会把死键虚增计数）。
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
  // 匹配联合类型成员中的 type 字面量（协议无常量表镜像，联合类型即唯一权威源）
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
// Agent 事件宿主消费对账守卫
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

// ──────────────────────────────────────────────────────────────
// ProcessEvent 宿主桥接对账守卫
//
// 治理背景：`ProcessEvent` 是「UI 状态重建真相源」（重放轨）。宿主 `chatPanel.consumeFlow`
// 是内核 AgentChunk → ProcessEvent 的**唯一桥接入库点**（`emitEvent`），新增 union 成员时若
// 忘记在此桥接，该类事件**永不落盘** → 重放静默缺失。
//
// 为何必须有守卫（现场教训）：消费侧一律 `e.type === 'x'` **正匹配**、无穷尽 switch，
// 且 `emitEvent` 签名是弱类型（`payload: ProcessEvent['payload']` + `as ProcessEvent`）——
// 因此「新增成员却无人落盘」**不会产生任何编译错误或类型检查拦截**，只能靠守卫兜住。
//
// 实例：`error` chunk 长期只 `post`（实时提示条）不 `emitEvent`（重放轨）→ 实时可见、回看不可见，
// 失败原因永久丢失（缺口）。
//
// 守卫语义：内核联合成员集（真理源）与宿主桥接集求差集，差集非空即失败 —— 强制新增事件时
// 同步桥接点，而非靠记忆自觉。
// ──────────────────────────────────────────────────────────────

/** roundStore.ts 路径（__dirname → shared → src → memora-vscode → hosts → 项目根 → src/memory） */
const ROUND_STORE_PATH = join(__dirname, '../../../../../src/memory/roundStore.ts');

/**
 * 从 roundStore.ts 提取 ProcessEvent 联合成员类型集（真理源）。
 *
 * 切片锚 = `export type ProcessEvent =` → `// ─── 问答闭环`；结构漂移时**抛错**而非静默返回空集
 * （空集会让差集恒空 = 假绿，是本守卫最危险的失效形态）。
 */
function extractProcessEventTypes(source: string): Set<string> {
  const blockStart = source.indexOf('export type ProcessEvent =');
  const blockEnd = source.indexOf('// ─── 问答闭环', blockStart);
  if (blockStart < 0 || blockEnd < 0) {
    throw new Error('无法定位 ProcessEvent 联合块（roundStore.ts 结构可能已变）');
  }
  // 剥注释：联合内注释含 `type:'x'` 形式的说明文字，不剥会误计为成员
  const block = source.slice(blockStart, blockEnd);
  const noBlockComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const noComments = noBlockComments.replace(/\/\/[^\n]*/g, '');
  const types = new Set<string>();
  const re = /type:\s*'([a-z_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    types.add(m[1]);
  }
  return types;
}

/** 从 chatPanel 源码提取 `emitEvent('x', ...)` 桥接的 ProcessEvent 类型名集（剥注释，防注释示例误计） */
function extractHostBridgedEventTypes(source: string): Set<string> {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const noComments = noBlockComments.replace(/\/\/[^\n]*/g, '');
  const types = new Set<string>();
  const re = /emitEvent\(\s*'([a-z_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    types.add(m[1]);
  }
  return types;
}

describe('ProcessEvent 宿主桥接对账守卫（V-3）', () => {
  it('测量工具自证：剥注释有效（注释/块注释内的 emitEvent 示例不得计入）', () => {
    const fake = "// emitEvent('ghost', {})\nconst x = 1;\n/* emitEvent('phantom', {}) */\n";
    expect(extractHostBridgedEventTypes(fake).size).toBe(0);
  });

  it('ProcessEvent 每个成员都应有宿主 emitEvent 桥接点（否则永不落盘 → 重放静默缺失）', () => {
    const kernelTypes = extractProcessEventTypes(readFileSync(ROUND_STORE_PATH, 'utf-8'));
    const bridged = extractHostBridgedEventTypes(readFileSync(CHAT_PANEL_PATH, 'utf-8'));

    // 前置事实（防「因错误的原因通过」）：两集均须非空且含已知成员 —— 若正则失配导致双空，
    // 差集也会空而假绿；这两条断言把该失效形态钉死。
    expect(kernelTypes.size, 'ProcessEvent 成员解析为空（切片/正则失配）').toBeGreaterThan(0);
    expect(bridged.size, 'emitEvent 桥接解析为空（正则失配）').toBeGreaterThan(0);
    expect(kernelTypes.has('aborted')).toBe(true);
    expect(bridged.has('aborted')).toBe(true);

    const missing: string[] = [];
    for (const t of kernelTypes) {
      if (!bridged.has(t)) missing.push(t);
    }
    expect(
      missing,
      `以下 ProcessEvent 成员在内核定义但宿主 chatPanel 无 emitEvent 桥接：[${missing.join(', ')}]。` +
        `该事件将永不落盘 → 重放静默缺失（无编译错误）。新增成员时须同步桥接点。`,
    ).toEqual([]);
  });
});
