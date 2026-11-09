/**
 * workProjectionBridge — 作品投影的 extension host 侧桥接
 *
 * 三件事，都在扩展宿主进程内（webview 只收数据、只发意图）：
 *  ① `load()` 把内核清单 + 求值报告派生成 DTO 推给设置页；
 *  ② `runWorkProjectionAction()` 是**四个动作入口共用的唯一执行面**
 *     （文件右键 / QuickPick / 命令面板 / 设置页行内按钮）；
 *  ③ `openWorkSource()` 处理新增的「单击打开原文件」。
 *
 * 🔴 零判据纪律：`hasAgent` / `listMalformed` / `entries` / `residentReport` 四项全部直读内核，
 * 形状翻译只在 `workProjectionRows.ts`。本文件不写「是不是项目规则」「超没超限」「文件在不在」。
 *
 * 🔴 打开通道的安全契约（新增「单击打开」时最容易漏的一条）：webview 回传的 `source`
 * 是**字符串**，等于一条「打开任意文件」的上行通道。故顺序固定为
 * 「先与内核清单对拍 → 再走 `refPath.resolveUnderPrimaryRoot` 单点解析 → 最后才 openTextDocument」。
 * 清单对拍挡伪造路径，refPath 挡绝对路径 / `..` 逃逸 / 非规范形——两者缺一即带伤。
 * 打开的是 VS Code 原生文本编辑器（可编辑），不是只读预览，也不是新开 Webview 面板。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import type {
  WorkProjectionAction,
  WorkProjectionViewState,
} from '../../shared/workProjectionDto.js';
import { deriveWorkProjectionView } from './workProjectionRows.js';
import { resolveUnderPrimaryRoot } from './refPath.js';

/** 内核结果面（结构对齐 setResident / unregisterWork，宿主只读这两字段） */
interface KernelResult {
  /** 粗粒度结果码（判据真源在内核，宿主只按成功态选提示通道） */
  reason: string;
  /** 人读文案（原样展示，禁止改写） */
  message: string;
}

/** 成功态结果码（仅决定用「信息」还是「错误」通道，不是能力判据） */
const SUCCESS_REASONS = new Set(['enabled', 'disabled', 'removed']);

/**
 * 展示内核回执（动作执行面的唯一出口）
 *
 * 成功走轻提示，失败走错误提示；**message 原样透传**（文案真源在内核）。
 *
 * @param result 内核返回面
 */
export function showKernelResult(result: KernelResult): void {
  if (SUCCESS_REASONS.has(result.reason)) {
    void vscode.window.showInformationMessage(result.message);
  } else {
    void vscode.window.showErrorMessage(result.message);
  }
}

/** 取 Agent 的闭包（入口各自提供：命令侧可装配、面板侧只读探视） */
export type AgentResolver = () => Promise<Agent | null>;

/**
 * 按清单相对路径翻转常驻态（**执行面真源**，与入口形态无关）
 *
 * 当前态一律读内核归一后的 `listManagedWorks()`，宿主不缓存、不反解 label。
 * 未登记 ⇒ 尝试置 true，由内核回 not-found + 指路文案。
 */
async function toggleByRelativePath(source: string, resolveAgent: AgentResolver): Promise<void> {
  const agent = await resolveAgent();
  if (!agent?.works) {
    void vscode.window.showWarningMessage('Memora Agent 未就绪，无法切换项目规则');
    return;
  }
  try {
    const entries = await agent.works.listManagedWorks();
    const current = entries.find((e) => e.source === source);
    showKernelResult(await agent.works.setResident(source, !current?.resident));
  } catch (err) {
    void vscode.window.showErrorMessage(
      '切换项目规则失败：' + (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** 仅移除登记（不删源文件；执行面真源） */
async function unregisterByRelativePath(
  source: string,
  resolveAgent: AgentResolver,
): Promise<void> {
  const agent = await resolveAgent();
  if (!agent?.works) {
    void vscode.window.showWarningMessage('Memora Agent 未就绪，无法移除作品投影');
    return;
  }
  try {
    // 文案与「删条目 ≠ 删文件」由内核 message 保证，这里只负责展示
    showKernelResult(await agent.works.unregisterWork(source));
  } catch (err) {
    void vscode.window.showErrorMessage(
      '移除作品投影失败：' + (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * 打开作品原文件（单击行）
 *
 * 判据复用而非重写：`resolveUnderPrimaryRoot` 本就是给「webview 回传路径」的上行通道
 * 准备的消费侧单点（`chatPanel.openRefInEditor` 同源），绝对路径 / `..` / 非规范形一律拒。
 */
async function openWorkSource(source: string, resolveAgent: AgentResolver): Promise<void> {
  const agent = await resolveAgent();
  if (!agent?.works) {
    void vscode.window.showWarningMessage('Memora Agent 未就绪，无法打开作品原文件');
    return;
  }

  // ① 清单对拍：只认清单里真实存在的 source。缺了这一步，伪造消息可诱导打开任意路径。
  let listed = false;
  try {
    listed = (await agent.works.listManagedWorks()).some((e) => e.source === source);
  } catch (err) {
    void vscode.window.showErrorMessage(
      '读取作品投影清单失败：' + (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  if (!listed) {
    void vscode.window.showWarningMessage(`无法打开作品：清单里没有 ${source}`);
    return;
  }

  // ② 首根解析（SSOT = refPath，与生成侧 toWorkspaceRelativePath 同一契约的两半）
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    void vscode.window.showWarningMessage('未打开工作区，无法定位作品原文件');
    return;
  }
  const abs = resolveUnderPrimaryRoot(root.uri.fsPath, source);
  if (!abs) {
    void vscode.window.showWarningMessage(`无法打开作品：路径不在首个工作区根内 ${source}`);
    return;
  }

  // ③ 打开真实文件（原生编辑器 = 可直接改，改完保存后下一轮装配重新读取）
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    void vscode.window.showErrorMessage(
      '打开作品原文件失败：' + (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * 动作执行面（唯一真源）：四个入口都只做「把意图变成 source」，翻转 / 移除 / 打开全在这里
 *
 * @param action 动作名
 * @param source 清单相对路径（load 不需要）
 * @param resolveAgent 取 Agent 的闭包（入口各异，执行面共用）
 */
export async function runWorkProjectionAction(
  action: WorkProjectionAction,
  source: string | undefined,
  resolveAgent: AgentResolver,
): Promise<void> {
  if (action === 'load') return;
  if (!source) {
    void vscode.window.showWarningMessage('未指定作品条目，无法执行该动作');
    return;
  }
  switch (action) {
    case 'open':
      await openWorkSource(source, resolveAgent);
      return;
    case 'toggle':
      await toggleByRelativePath(source, resolveAgent);
      return;
    case 'unregister':
      await unregisterByRelativePath(source, resolveAgent);
      return;
  }
}

/** 桥接依赖（settingsPanel 注入，避免本模块反向依赖面板类） */
export interface WorkProjectionBridgeDeps {
  /** 向 webview 推一条消息（面板未就绪时由调用方静默丢弃） */
  post(msg: ExtensionToWebviewMessage): void;
  /** 只读探视已装配 Agent（**不得触发懒装配**：打开设置页不该付出装配成本） */
  peekAgent(): Agent | undefined;
}

/** 作品投影数据桥（设置面板持有一个实例） */
export class WorkProjectionBridge {
  constructor(private readonly deps: WorkProjectionBridgeDeps) {}

  /**
   * 派生并推送当前视图状态
   *
   * 与退役的 TreeView provider 同口径：报告为 null / listReadable=false 由派生层给 notice，
   * **不得**显示成「零失效」。
   */
  async load(): Promise<void> {
    let state: WorkProjectionViewState;
    try {
      const agent = this.deps.peekAgent();
      if (!agent?.works) {
        state = deriveWorkProjectionView({
          hasAgent: false,
          listMalformed: false,
          entries: [],
          residentReport: null,
        });
      } else {
        const works = agent.works;
        state = deriveWorkProjectionView({
          hasAgent: true,
          // 格式异常时内核拒绝写入：必须让用户看见，否则「登记后什么都没变」无法解释
          listMalformed: works.isFileMalformed,
          entries: await works.listManagedWorks(),
          residentReport: agent.residentSegmentReport,
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      state = { kind: 'error', message: '读取作品投影失败：' + detail };
    }
    this.deps.post({ type: 'work_projection', state });
  }

  /** webview 动作入口：执行后立刻回推最新态（不等下一次 ready / 可见性变化） */
  async handle(action: WorkProjectionAction, source?: string): Promise<void> {
    if (action === 'load') {
      await this.load();
      return;
    }
    await runWorkProjectionAction(action, source, async () => this.deps.peekAgent() ?? null);
    await this.load();
  }
}

// ─── 清单变更通知（登记 / 切换 / 移除后回推；报告刷新由设置面板订阅内核事件单独驱动） ───

let changeListener: (() => void) | null = null;

/** 注册唯一的清单变更消费者（设置面板构造时注册；照 `setMcpStatusListener` 同型） */
export function setWorkProjectionListener(next: (() => void) | null): void {
  changeListener = next;
}

/** 清单被本进程改动后广播（extension.ts 的两处 onMutated 回调共用） */
export function notifyWorkProjectionChanged(): void {
  changeListener?.();
}
