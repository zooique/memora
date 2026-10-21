/**
 * 发送时刻的注入正文采集（HOST-CTX-4 ④）——vscode 绑定的**正文组装层**
 *
 * 与纯采集器的分层：`problemsCollector` / `gitCollector` 是零 `vscode` 依赖的纯逻辑
 * （exec / readLine 注入式，可纯 node 单测）；本模块是它们的**生产装配处**——负责取
 * vscode 事实（getDiagnostics / 首工作区根）、调纯采集器、把一切失败收成「事实行」。
 *
 * 时序纪律（全模块共用，勿在各函数里重复）：
 *   - 采集时机恒为**发送时刻**——挂载只记通道标记（webview 组合态），宿主不持有注入态
 *     ⇒ 无缓存、无第二真理源。缓存的快照 ≠ 发送时刻的真相（CTX-3 的 `_docContext`
 *     缓存撒谎就是死在这上面）。
 *   - 失败也返回**事实行**而非空串或抛错——用户挂了标签就有权知道「确实没有」或「没
 *     取到」；静默空块 = 静默失败族，抛错则整条发送毫无反应（本项目已四次踩）。
 *
 * 为何独立成文件（自 chatPanel.ts 拆出）：该文件贴 eslint max-lines 上限，而「发送时刻
 * 采集」是随注入源数量**线性增长**的域——每加一个源（git-changes / 未来的 terminal）
 * 都要在此加一个 collectXxxBody，域留在贴限文件里必然爆线。本模块即该域的家园。
 */
import * as vscode from 'vscode';
import { collectProblemsText } from './problemsCollector.js';

/** 诊断的「源码行」读取（生产实现，注入给 `collectProblemsText`）
 *
 * **优先读已打开文档的 buffer**：诊断是语言服务基于 buffer 算出来的（含未保存修改），
 * 读磁盘会与诊断给出的行号错位——与 `registerWork` 读磁盘的旧版隐患（HOST-MENU-2）
 * 是同一个病根，此处反向处置（要新不要旧）。未打开的文件才回退读盘（有界：读一次、取整行）。
 *
 * 任何失败一律返回 undefined ⇒ 该条诊断降级为「不带源码行」（功能不残，只是少一点上下文），
 * 不因取不到源码而整块放弃。
 */
async function readProblemsSourceLine(uri: string, line: number): Promise<string | undefined> {
  if (line < 0) return undefined;
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
  if (open) {
    const idx = Math.min(line, open.lineCount - 1);
    return idx >= 0 ? open.lineAt(idx).text : undefined;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(uri));
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
    return lines[line];
  } catch {
    return undefined;
  }
}

/**
 * 本轮诊断正文采集（HOST-CTX-4 ④ problems 源；时序与失败纪律见模块头）
 */
export async function collectProblemsBody(): Promise<string> {
  try {
    const groups = vscode.languages.getDiagnostics().map(([uri, diagnostics]) => ({
      uri: uri.toString(),
      fsPath: uri.fsPath,
      diagnostics,
    }));
    return await collectProblemsText({
      groups,
      // 首根 SSOT：诊断路径必须投影到与 read_file cwd / 引用解析同一个根，否则模型读不到
      rootFsPath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      readLine: readProblemsSourceLine,
    });
  } catch (err) {
    // 取数失败**不得**让整条发送挂掉（用户点发送后毫无反应 = 静默失败族，本项目已四次踩）。
    // 与采集器「永不返回空串」同纪律：失败也要在信封里留一句**事实**，模型知道用户挂了
    // 但没拿到，而不是收到一个空块后凭空编诊断。
    console.warn('[memora] 采集工作区诊断失败，本轮以事实行代替：', err);
    return '工作区诊断采集失败（本轮未能取到错误 / 警告列表）。';
  }
}
