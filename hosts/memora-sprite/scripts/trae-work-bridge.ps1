# TRAE Work 桥接器 — 自动注入提示词验证脚本
# 用途：验证 Sprite → TRAE Work 自动化链路（写剪贴板 → 聚焦窗口 → 粘贴 + 发送）
# 用法：./scripts/trae-work-bridge.ps1 -Prompt "你的提示词"
#       ./scripts/trae-work-bridge.ps1  # 使用默认测试提示词
# 前提：TRAE Work 已打开，且输入框在窗口聚焦时自动获得光标

param(
    # 要注入到 TRAE Work 的提示词内容
    [string]$Prompt = "请帮我检查当前项目的测试是否全部通过",

    # 聚焦窗口后的等待时间（毫秒），确保窗口完全激活
    [int]$FocusDelayMs = 500,

    # 粘贴内容后的等待时间（毫秒），确保剪贴板内容完全写入输入框
    [int]$PasteDelayMs = 300,

    # 是否按 Enter 发送（某些场景可能需要 Ctrl+Enter，设为 $false 仅粘贴不发送）
    [bool]$SendOnEnter = $true
)

# ─── 1. 写入系统剪贴板 ──────────────────────────────────────
Set-Clipboard -Value $Prompt
$preview = if ($Prompt.Length -gt 50) { $Prompt.Substring(0, 50) + "..." } else { $Prompt }
Write-Host "[1/4] 剪贴板已写入：$preview" -ForegroundColor Green

# ─── 2. 查找 TRAE Work 进程 ──────────────────────────────────
# Electron 应用的窗口标题通常为 "项目名 — TRAE" 或类似格式
# 用 MainWindowTitle 匹配更准确（进程名可能不稳定）
$traeProcess = Get-Process | Where-Object {
    $_.MainWindowTitle -match "Trae|TRAE" -and $_.MainWindowHandle -ne 0
} | Select-Object -First 1

if (-not $traeProcess) {
    Write-Host "[错误] 未找到 TRAE Work 窗口，请确认 TRAE Work 已打开" -ForegroundColor Red
    Write-Host "        当前所有可见窗口：" -ForegroundColor Gray
    Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne "" } | 
        ForEach-Object { Write-Host "          - $($_.MainWindowTitle)" -ForegroundColor Gray }
    exit 1
}

Write-Host "[2/4] 找到 TRAE Work 窗口：$($traeProcess.MainWindowTitle)" -ForegroundColor Green

# ─── 3. 激活 TRAE Work 窗口 ─────────────────────────────────
# AppActivate 通过进程 ID 激活窗口，内部调用 SetForegroundWindow
# Windows 有焦点窃取防护，AppActivate 会尝试绕过
Add-Type -AssemblyName Microsoft.VisualBasic
try {
    [Microsoft.VisualBasic.Interaction]::AppActivate($traeProcess.Id)
    Start-Sleep -Milliseconds $FocusDelayMs
    Write-Host "[3/4] 已激活 TRAE Work 窗口" -ForegroundColor Green
} catch {
    Write-Host "[错误] 无法激活窗口：$_" -ForegroundColor Red
    exit 1
}

# ─── 4. 模拟 Ctrl+V 粘贴 + Enter 发送 ───────────────────────
Add-Type -AssemblyName System.Windows.Forms

# 发送 Ctrl+V（粘贴剪贴板内容到已聚焦的输入框）
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds $PasteDelayMs
Write-Host "[4/4] 已粘贴提示词内容" -ForegroundColor Green

# 可选：发送 Enter 提交
if ($SendOnEnter) {
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Write-Host "      已按 Enter 发送" -ForegroundColor Green
} else {
    Write-Host "      跳过发送（-SendOnEnter `$false）" -ForegroundColor Yellow
}

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Write-Host "提示词已注入 TRAE Work。请观察 TRAE Work 是否正确接收并开始处理。" -ForegroundColor Cyan
