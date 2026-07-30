---
alwaysApply: false
description: "跨进程非 ASCII 数据传递：文件 I/O 优于 stdout 管道 + 第三方库编码 bug 绕过策略"
---

# ADR-SP-018 · 跨进程非 ASCII 数据传递：文件 I/O + 原始数据提取

> **状态**：✅ 已接受
> **日期**：2026-07-19
> **来源**：窗口标题中文乱码修复（详见 [docs/案例-窗口标题中文乱码修复.md](../../hosts/memora-sprite/docs/案例-窗口标题中文乱码修复.md)）
> **依赖**：[ADR-SP-003](./ADR-SP-003-desktop-shell.md)（Electron 桌面壳）、[ADR-SP-017](./ADR-SP-017-quick-input-architecture.md)（快速输入浮窗架构）

## 背景

memora-sprite 的快速输入浮窗需要在呼出前捕获前台窗口标题，用于显示"聚焦：{应用名}"并提取应用名。使用 `@nut-tree-fork/nut-js` 获取窗口标题时，中文标题出现乱码。

经多层排查发现**三个独立的编码故障点叠加**：

1. **nut-js 底层 ANSI 编码 bug**：`@nut-tree-fork/libnut-win32` 调用 `GetWindowTextA`（ANSI 版本），在中文 Windows（CP936/GBK）上返回 GBK 字节，nut-js 将其误作 UTF-8 传给 Node.js napi，产生不可逆的 U+FFFD 替换字符——原始信息永久丢失。

2. **PowerShell stdout 编码污染**：fallback 方案通过 `execSync` 调用 PowerShell 获取标题，即使使用 base64 编码（纯 ASCII），管道传输过程中仍受系统 OEM 代码页影响，输出被污染为 `㧝䶝캚` 等合法但错误的 Unicode 字符。

3. **竞态条件**：fallback 方案中 PowerShell 调用 `GetForegroundWindow()` 重新获取前台窗口，但 `await nut-js title` 之后前台窗口可能已被系统通知/弹窗切换，导致拿到错误窗口的标题。

**曾失败的修复尝试**（均只修下游症状，未触及上游根因）：

| 修复尝试 | 为什么失败 |
|---------|-----------|
| 检测 U+FFFD 后用 PowerShell 修复 | PowerShell stdout 编码污染，返回的标题仍然乱码 |
| base64 编码绕过 stdout 编码 | 管道传输中仍有隐蔽的编码层污染 |
| `Add-Type -MemberDefinition` + `CharSet.Unicode` | MemberDefinition 对 DllImport 命名参数解析存在不一致，CharSet 声明可能不生效 |
| `Add-Type -TypeDefinition` + 显式 W 后缀 | API 调用正确了，但 stdout 传递链路仍不可靠 |

## 决策

### 1. 跨进程非 ASCII 数据传递：文件 I/O 优于 stdout 管道

**当 Node.js 通过 `child_process.execSync` 调用 PowerShell（或其他子进程）获取非 ASCII 数据时，必须通过临时文件传递结果，禁止依赖 stdout 管道。**

```typescript
// ✅ 正确：PowerShell 写临时文件，Node.js 读文件
execSync(`powershell ... -EncodedCommand ${encoded}`, { stdio: 'ignore' });
const buf = fs.readFileSync(tmpFile);
const title = buf.toString('utf16le');

// ❌ 错误：依赖 stdout + base64，受系统代码页污染
const result = execSync(`powershell ...`, { encoding: 'utf8' });
const title = Buffer.from(result.trim(), 'base64').toString('utf16le');
```

**判定标准**：当子进程输出包含非 ASCII 字符（中文/日文/韩文/emoji 等）时，用文件 I/O；纯 ASCII 输出（数字/英文/状态码）可用 stdout。

### 2. 第三方库编码 bug：提取原始数据绕过，而非修补

**当第三方库（nut-js 等）的底层实现存在编码 bug 且无法修改时，提取库内部的原始数据，自己调用正确的 API，而非在下游检测乱码 + fallback。**

```typescript
// ✅ 正确：提取 nut-js Window 内部的 HWND，自己调用 GetWindowTextW
const win = await nutJs.getActiveWindow();
const hwnd = (win as unknown as { windowHandle?: number }).windowHandle;
// 用 hwnd 调用 GetWindowTextW，绕过 nut-js 的 GetWindowTextA

// ❌ 错误：用 nut-js 的 title（已乱码），再尝试 fallback 修复
const title = await win.title; // U+FFFD，原始信息已丢失，无法修复
```

**判定标准**：当第三方库返回的数据已发生**不可逆损坏**（如 U+FFFD 替换字符）时，必须绕过该库，提取原始数据自行处理；只有损坏可逆时才考虑 fallback 修复。

### 3. 消除竞态：用捕获时的句柄，而非重新查询

**当需要获取某个窗口的属性（标题/区域等）时，使用捕获时保存的窗口句柄（HWND），而非在后续步骤中重新调用 `GetForegroundWindow()` 查询。**

```typescript
// ✅ 正确：传入捕获时的 HWND
function getWindowTitleViaPS(hwnd: number): string | null { ... }

// ❌ 错误：重新查询前台窗口（可能已切换）
function getForegroundWindowTitleViaPS(): string | null {
  // GetForegroundWindow() 可能拿到错误窗口
}
```

## 理由

| 考虑 | 说明 |
|------|------|
| **stdout 管道在 Electron + PowerShell 环境下不可靠** | PowerShell stdout 受系统 OEM 代码页影响，中文 Windows 下为 CP936，即使 base64 编码也可能在管道传输中被污染 |
| **文件 I/O 是零编码转换的** | PowerShell 用 `[System.IO.File]::WriteAllBytes()` 写入 UTF-16LE 字节，Node.js 用 `fs.readFileSync()` + `.toString('utf16le')` 读取，全程无代码页介入 |
| **不可逆损坏无法 fallback** | U+FFFD 替换字符意味着原始字节已丢失，任何下游修复都无法恢复，必须从源头绕过 |
| **竞态条件在异步代码中隐蔽** | `await` 前后前台窗口可能切换，用捕获时的 HWND 可 100% 定位目标窗口 |
| **绕过比修补更可靠** | 修补方案（检测乱码 + fallback）的 fallback 链路本身也可能有编码问题；绕过方案控制了整条链路 |

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| stdout + base64 传递 | 管道传输中受系统代码页污染，base64 输出被破坏 |
| `Add-Type -MemberDefinition` + `CharSet.Unicode` | MemberDefinition 对 DllImport 命名参数解析不一致，CharSet 可能不生效 |
| `Add-Type -TypeDefinition` + 显式 W 后缀（仅改 API 调用） | API 调用正确了，但 stdout 传递链路仍不可靠 |
| 检测 U+FFFD 后用 nut-js 其他 API 修复 | nut-js 所有窗口标题 API 都走 GetWindowTextA，无法绕过 |
| 提交 PR 修复 nut-js 底层 bug | 第三方库修复周期长，且 libnut 已半废弃，不等待 |
| 用 Win32 原生模块替代 nut-js | nut-js 还负责键盘模拟（Ctrl+V），替换成本高；仅标题获取绕过即可 |

## 影响

- **`pasteCoordinator.ts`**：`getWindowTitleViaPS(hwnd)` 函数接受 HWND 参数 + 文件 I/O，替代旧的 `getForegroundWindowTitleViaPS()`（无参数 + stdout）
- **`inputInjector.ts`**：`ActiveWindow` 接口新增 `hwnd?: number` 字段，`getDefaultInputInjector` 提取 `windowHandle`
- **跨进程通信规范**：所有涉及非 ASCII 数据的 `execSync` 调用应遵循文件 I/O 模式
- **第三方库 bug 应对策略**：优先提取原始数据绕过，而非下游 fallback 修补

## 何时回顾

- 当 nut-js 升级修复了 `GetWindowTextA` 编码 bug 时，可评估是否移除 PowerShell fallback，直接用 `await window.title`
- 当项目中出现其他跨进程非 ASCII 数据传递场景时，验证文件 I/O 模式是否仍然必要（是否 PowerShell Core / pwsh 的 stdout 编码更可靠）
- 当文件 I/O 模式导致性能问题（频繁创建临时文件）时，评估是否需要文件句柄池或其他优化

## 引用

- 完整案例文档：[案例-窗口标题中文乱码修复.md](../../hosts/memora-sprite/docs/案例-窗口标题中文乱码修复.md)
- 相关代码：[pasteCoordinator.ts](../../hosts/memora-sprite/src/electron/windows/pasteCoordinator.ts) `getWindowTitleViaPS()`
- 相关代码：[inputInjector.ts](../../hosts/memora-sprite/src/electron/inputInjector.ts) `ActiveWindow.hwnd`
