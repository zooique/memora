/**
 * 图片落盘 —— 图片进盘的宿主侧单点（采集即写盘，两条入口共用本模块）
 *
 * ## 为什么单独成模块（不塞进 chatPanel）
 * chatPanel 已顶 `max-lines` 红线（eslint 集中豁免清单里是只降不升的基线），而落盘
 * 需要 fs / crypto / 目录推导三件事——塞进面板类会同时踩「文件体量」与「职责边界」
 * 两条线。本模块**零 vscode 依赖**（只用 `node:*` + 纯函数），因此可在 vitest 里
 * 以真实临时目录完整机测，无需 mock 宿主 API。
 *
 * ## 两条入口（同一套真相纪律，禁各自为政）
 * - `ingestImage`：粘贴/拖入（webview base64 上行，`image_ingest` → `image_ingest_result`）。
 *   字节过通道 ⇒ 先过 base64 往返校验再谈别的。
 * - `ingestDiskFile`：原生文件选择框（Q3，宿主直接读盘，`image_picked` 回执）。
 *   **不传声明 mime**——扩展名不可信（把 png 命名成 .jpg 与把文本命名成 .png 同价），
   格式只认字节嗅探（第 4 步「与声明一致」整环跳过）。
 * 共享面：sha256 复算（宿主是唯一真相生产点，webview 侧只有提案）、校验链函数、
 * 写盘原语（`writeOnce` 并发幂等）与 ref 组装（`buildImageRef`）——两个入口**都不得**
 * 另写嗅探 / 目录映射 / 扩展名推导（第二份公式必漂移）。
 *
 * ## 职责边界（刻意划死）
 * - **只负责**：拿字节（解码或读盘）→ 字节层校验 → 复算 sha256（真值）→ 写
 *   `<数据目录>/attachments/{sha256}.{ext}` → 回执三态。
 * - **不负责**：六步校验链的「业务判据」（在 `shared/imageValidation.ts` 单点，
 *   本模块**复用同一函数**，绝不另写一套嗅探公式——第二套公式必漂移）；也不负责
 *   chip 渲染 / 消息发送 / 孤儿清理。
 *
 * ## 三态语义（与协议两条回执的注释同源）
 * - `ok`：已写盘，`ref` = 本模块复算的**真值** `ImageRef`（webview 据此建/换 chip）；
 * - `rejected`：字节层不可用（base64 非法 / 嗅不出图片 magic），**坏字节不写盘**；
 * - `failed`：IO 故障（读盘失败 / 磁盘满 / 权限），可重试。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
// 值导入内核（node 侧合法；webview 打包不经过本模块）：token 公式单点，回执 tokens 字段（IMG-8）
import { imageTokens, type ImageRef } from '@zooique/memora';
import {
  type ImageAccept,
  validateImageCandidate,
  verifyBase64RoundTrip,
} from '../../shared/imageValidation.js';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { resolveAttachmentsDir, resolveAttachmentFilePath } from './projectDataDir.js';

/** 上行载荷类型（从协议联合取型，禁手写第二份字段表） */
type ImageIngestMessage = Extract<WebviewToExtensionMessage, { type: 'image_ingest' }>;
/** 下行回执类型（同上） */
type ImageIngestResult = Extract<ExtensionToWebviewMessage, { type: 'image_ingest_result' }>;
/** 拾取回执类型（Q3 文件选择框路径） */
type ImagePickedResult = Extract<ExtensionToWebviewMessage, { type: 'image_picked' }>;

/**
 * 真值 `ImageRef` 组装（两条入口共用的唯一字段表）。
 *
 * name 取校验链产物（无名时已按 D29 兜底），宽高来自嗅探出的文件头，bytes = 实际字节
 * 长度。任何一侧入口另写一份字段映射，都会在将来 ImageRef 加字段时静默漏一侧。
 */
function buildImageRef(bytes: Uint8Array, sha256: string, checked: ImageAccept): ImageRef {
  return {
    sha256,
    mime: checked.mime,
    width: checked.width,
    height: checked.height,
    bytes: bytes.length,
    name: checked.name,
  };
}

/**
 * 同 sha256 的并发写序列化表（键 = 目标文件绝对路径）。
 *
 * 为什么需要：同一张图连粘两次会发来两份**相同**字节的两条 `image_ingest`，两个
 * `writeFile` 并发打开同一路径时，一个截断、另一个写到一半，理论上可留下零填充的
 * 半截文件（后续预览就是坏图）。共用同一个 Promise 即天然幂等：先到者写、后到者
 * 等它写完直接复用结果，**不重复写**。
 */
const inflightWrites = new Map<string, Promise<void>>();

/**
 * 写入目标文件（同路径并发只写一次）。
 *
 * @param dir 目标目录（`attachments/`，不存在则递归创建）
 * @param file 目标文件绝对路径
 * @param bytes 文件内容
 */
async function writeOnce(dir: string, file: string, bytes: Uint8Array): Promise<void> {
  const running = inflightWrites.get(file);
  if (running) return running;
  const task = (async () => {
    // recursive:true 兼作「已存在即无操作」，且关闭「先 stat 后建」的 TOCTOU 窗口
    await mkdir(dir, { recursive: true });
    await writeFile(file, bytes);
  })().finally(() => inflightWrites.delete(file));
  inflightWrites.set(file, task);
  return task;
}

/**
 * 处理一条 `image_ingest`：解码 → 自检 → 复算真值 → 写盘 → 回执。
 *
 * 任何失败都**必须**回执（三态之一），不静默丢弃——webview 的 chip 会停在「等回执」
 * 的中间态，静默失败就是最坏的失败形态（用户以为图已就绪、实际没落盘）。
 *
 * @param projectPath 项目/工作区根（绝对路径；目录推导归 `projectDataDir.ts` 单点）
 * @param msg 上行载荷（字段语义见 `shared/protocol.ts`）
 * @param post 回执通道（注入以便单测直接断言，不触 vscode）
 * @param toWebviewUri 落盘文件 → webview 可加载 URL（悬停预览用）。注入而非本模块直接调
 *   `asWebviewUri`：那要 import `vscode`，而本模块的「零 vscode 依赖」是能拿真临时目录机测
 *   的前提。缺省（不传）= 回执不带 `uri`，UI 如实显示「暂无预览」。
 *   返回值允许 `undefined`：转换器由调用方闭包持有视图引用，写盘期间视图可能已被销毁，
 *   此时拿不到真实地址——返回 `undefined` 让本处不带字段，绝不用空串伪装成可加载地址。
 * @param warmCache 写盘成功后的字节缓存预热钩子（真机验收 IMG-2 第 13 子块断点A）。
 *   唯一生产实现 = `ImageCache.preload`（读盘 → D20 三值校验 → 入缓存）。**必须**在 ok
 *   回执之前调用：回执到达 webview 后用户随时可能发送，此时同步 `ImageResolver` 查表——
 *   若只靠「会话加载期预读」（`preloadSession`），新会话首发时图刚落盘、预读发生在它之前，
 *   查表必 miss ⇒ 内核 D7 推 `[图片不可用]` 占位（真机实锤）。落盘与入缓存之间不许有缝。
 */
export async function ingestImage(
  projectPath: string,
  msg: ImageIngestMessage,
  post: (msg: ImageIngestResult) => void,
  toWebviewUri?: (file: string) => string | undefined,
  warmCache?: (ref: ImageRef) => void,
): Promise<void> {
  // 关联键 = 采集侧提案 sha256。三态回执都必须原样带回，否则 webview 无从知道
  // 这条回执属于哪一张 chip（多图并发时按文件名猜 = 张冠李戴）。
  const key = msg.sha256;

  let bytes: Uint8Array;
  try {
    // Buffer.from 对非法字符是**静默忽略**而非抛错，故解码本身不能当校验用
    bytes = Buffer.from(msg.base64, 'base64');
  } catch {
    post({
      type: 'image_ingest_result',
      status: 'rejected',
      sha256: key,
      reason: '图片数据读取失败',
    });
    return;
  }

  // 第 5 步（base64 往返长度）：与采集侧同一个纯函数——只判字符集 + 分组 + 长度，
  // 能把「截断 / 非法字符」这两类静默坏图挡在写盘之前。
  if (!verifyBase64RoundTrip(bytes.length, msg.base64)) {
    post({
      type: 'image_ingest_result',
      status: 'rejected',
      sha256: key,
      reason: '图片数据传输不完整（base64 校验失败）',
    });
    return;
  }

  // sha256 的**唯一生产点**是这里（webview 侧只是提案）：同一份字节算出的摘要必然
  // 与提案相同，但契约上只认宿主这一份——物理文件名 / 去重键 / 后续孤儿扫描全依赖它。
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // 剩余校验环（非空 / 上限 / magic 嗅探 / 声明一致 / 尺寸）复用同一函数：
  // 对同一份字节是确定性结果，故「提案 mime 与嗅探结果不一致」只可能是传输损坏
  const checked = validateImageCandidate(bytes, sha256, msg.mime, msg.name);
  if (!checked.ok) {
    post({ type: 'image_ingest_result', status: 'rejected', sha256: key, reason: checked.message });
    return;
  }

  // 真值 ImageRef：name 取校验链产物（无名时已按 D29 兜底），宽高来自嗅探出的文件头
  const ref = buildImageRef(bytes, sha256, checked);

  const dir = resolveAttachmentsDir(projectPath);
  // 文件名唯一推导点 = projectDataDir（写盘与预读共用同一映射，禁此处再拼扩展名）
  const file = resolveAttachmentFilePath(projectPath, sha256, checked.mime);
  try {
    await writeOnce(dir, file, bytes);
  } catch (err) {
    post({
      type: 'image_ingest_result',
      status: 'failed',
      sha256: key,
      reason: `图片保存失败：${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // 预热字节缓存（断点A）：先于 ok 回执——回执到达 webview 后用户随时可能发送，
  // 同步 resolver 查表必须命中（只靠会话加载期预读则新会话首发必 miss，见第 5 参注释）
  warmCache?.(ref);

  // `uri` 只承载「现有视图能加载的地址」：视图已销毁时上游不给转换器，此处就不带字段
  // tokens（IMG-8）：宿主按内核单点换算随回执回传，webview 只求和不重写公式
  post({
    type: 'image_ingest_result',
    status: 'ok',
    sha256: key,
    ref,
    tokens: imageTokens(ref),
    uri: toWebviewUri?.(file),
  });
}

/**
 * 处理一个磁盘拾取文件（Q3 文件选择框）：读盘 → 复算真值 → 校验 → 写盘 → 回执。
 *
 * 与 `ingestImage` 的三处刻意差异：
 * - **无 base64 环节**：字节由本模块直接 `readFile`，从未经过 webview 通道，
 *   第 5 步往返校验无从谈起（也没有 base64 可谈）；
 * - **不传声明 mime**：扩展名不可信，格式只认嗅探（`validateImageCandidate` 第 4 参
 *   缺省 = 第 4 步整环跳过）；
 * - **回执走 `image_picked`**：本路径没有「先有提案 chip」的时序，webview 收到 ok
 *   才第一次建 chip（ref 即真相）；rejected/failed 转可见拒收 chip（name = basename）。
 *
 * 关联键说明：`image_picked` 不带 sha 关联键——本路径的回执没有可配对的既有 chip，
 * 一次多选逐张回执，webview 按 ok 的 `ref` 直接追加、按失败项的 `name` 上拒收 chip；
 * 去重（G4）由 webview 按 `ref.sha256` 兜底（同一张图选两次只留一条）。
 *
 * @param projectPath 项目/工作区根（绝对路径；目录推导归 `projectDataDir.ts` 单点）
 * @param filePath 用户在原生对话框里选中的文件绝对路径（`Uri.fsPath`）
 * @param post 回执通道（注入以便单测直接断言，不触 vscode）
 * @param toWebviewUri 落盘文件 → webview 可加载 URL（语义同 `ingestImage` 第 4 参）
 * @param warmCache 写盘成功后的字节缓存预热钩子（语义同 `ingestImage` 第 5 参，两入口同一判据）
 */
export async function ingestDiskFile(
  projectPath: string,
  filePath: string,
  post: (msg: ImagePickedResult) => void,
  toWebviewUri?: (file: string) => string | undefined,
  warmCache?: (ref: ImageRef) => void,
): Promise<void> {
  const name = basename(filePath);

  let bytes: Uint8Array;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    // 读盘失败是 IO 故障（文件刚被删 / 无权限 / 被占用）⇒ failed 可重试，不伪装 rejected
    post({
      type: 'image_picked',
      status: 'failed',
      name,
      reason: `图片读取失败：${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // sha256 的宿主侧真相生产点（与 ingestImage 同一纪律：webview/文件名都只是提案）
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // 第 4 参刻意缺省：扩展名不可信 ⇒ 「与声明一致」环整环跳过，嗅探说了算
  const checked = validateImageCandidate(bytes, sha256, undefined, name);
  if (!checked.ok) {
    post({
      type: 'image_picked',
      status: 'rejected',
      name,
      reason: `图片校验未通过：${checked.message}`,
    });
    return;
  }

  const dir = resolveAttachmentsDir(projectPath);
  // 文件名唯一推导点 = projectDataDir（与写盘/预读共用同一映射，禁此处再拼扩展名）
  const file = resolveAttachmentFilePath(projectPath, sha256, checked.mime);
  try {
    await writeOnce(dir, file, bytes);
  } catch (err) {
    post({
      type: 'image_picked',
      status: 'failed',
      name,
      reason: `图片保存失败：${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // 预热字节缓存（断点A，先于 ok 回执；语义与粘贴路径同一判据）
  const ref = buildImageRef(bytes, sha256, checked);
  warmCache?.(ref);

  post({
    type: 'image_picked',
    status: 'ok',
    name,
    ref,
    tokens: imageTokens(ref),
    uri: toWebviewUri?.(file),
  });
}
