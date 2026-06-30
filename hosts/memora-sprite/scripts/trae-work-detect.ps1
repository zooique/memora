# TRAE Work 状态诊断脚本
# 用途：探测 TRAE Work 窗口的可观察信号，确定"生成中/空闲"状态检测方案
# 用法：./scripts/trae-work-detect.ps1
#       ./scripts/trae-work-detect.ps1 -Continuous   # 持续轮询模式（每 2 秒检测一次）
#       ./scripts/trae-work-detect.ps1 -TakeScreenshot  # 截取窗口截图到桌面

param(
    # 持续轮询模式：每 N 秒检测一次状态
    [switch]$Continuous,
    [int]$PollIntervalMs = 2000,

    # 截取窗口截图到桌面（用于人工观察 UI 状态特征）
    [switch]$TakeScreenshot,

    # 最大轮询次数（防止无限运行）
    [int]$MaxPolls = 30
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ─── 1. 查找 TRAE Work 窗口 ──────────────────────────────────
function Find-TraeWindow {
    $process = Get-Process | Where-Object {
        $_.MainWindowTitle -match "Trae|TRAE" -and $_.MainWindowHandle -ne 0
    } | Select-Object -First 1
    return $process
}

# ─── 2. UI Automation 元素枚举 ───────────────────────────────
# 尝试通过 Windows UI Automation 读取窗口元素树
function Get-UIElements {
    param([System.IntPtr]$WindowHandle)

    try {
        # 加载 UIAutomation 程序集
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop

        $automation = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true
        )
        $elements = $automation.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
        )

        # 收集前 100 个元素的关键信息
        $results = @()
        $count = [Math]::Min($elements.Count, 100)
        for ($i = 0; $i -lt $count; $i++) {
            $el = $elements[$i]
            $name = try { $el.Current.Name } catch { "" }
            $type = try { $el.Current.ControlType.ProgrammaticName } catch { "Unknown" }
            $className = try { $el.Current.ClassName } catch { "" }
            $bounds = try { $el.Current.BoundingRect } catch { [System.Drawing.Rectangle]::Empty }

            if ($name -or $className) {
                $results += [PSCustomObject]@{
                    Index = $i
                    Name = if ($name.Length -gt 60) { $name.Substring(0, 60) + "..." } else { $name }
                    Type = $type
                    ClassName = $className
                    Bounds = "$([int]$bounds.X),$([int]$bounds.Y) $([int]$bounds.Width)x$([int]$bounds.Height)"
                }
            }
        }
        return $results
    } catch {
        Write-Host "  [UI Automation] 加载失败：$($_.Exception.Message)" -ForegroundColor Yellow
        return @()
    }
}

# ─── 3. 网络流量监控 ────────────────────────────────────────
function Get-NetworkBytes {
    param([int]$ProcessId)
    try {
        # 获取进程的 TCP 连接数和总字节数
        $connections = Get-NetTCPConnection -OwningProcess $ProcessId -ErrorAction SilentlyContinue
        $activeCount = ($connections | Where-Object { $_.State -eq "Established" }).Count
        return [PSCustomObject]@{
            ActiveConnections = $activeCount
            TotalConnections = $connections.Count
        }
    } catch {
        return [PSCustomObject]@{ ActiveConnections = -1; TotalConnections = -1 }
    }
}

# ─── 4. 截图 ───────────────────────────────────────────────
function Take-WindowScreenshot {
    param([System.IntPtr]$WindowHandle, [string]$OutputPath)

    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32Capture {
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);
        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);
        [DllImport("gdi32.dll")]
        public static extern bool BitBlt(IntPtr hdcDest, int xDest, int yDest, int wDest, int hDest,
            IntPtr hdcSource, int xSrc, int ySrc, int rop);
        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr hObject);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    }
"@

    $rect = New-Object Win32Capture+RECT
    [Win32Capture]::GetWindowRect($WindowHandle, [ref]$rect) | Out-Null

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top

    if ($width -le 0 -or $height -le 0) {
        Write-Host "  [截图] 窗口尺寸无效 ($width x $height)" -ForegroundColor Yellow
        return
    }

    $srcDC = [Win32Capture]::GetDC($WindowHandle)
    $memDC = [Win32Capture]::CreateCompatibleDC($srcDC)
    $hBitmap = [Win32Capture]::CreateCompatibleBitmap($srcDC, $width, $height)
    $oldBitmap = [Win32Capture]::SelectObject($memDC, $hBitmap)
    [Win32Capture]::BitBlt($memDC, 0, 0, $width, $height, $srcDC, 0, 0, 0x00CC0020) | Out-Null

    $bitmap = [System.Drawing.Image]::FromHbitmap($hBitmap)
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

    [Win32Capture]::SelectObject($memDC, $oldBitmap) | Out-Null
    [Win32Capture]::DeleteObject($hBitmap) | Out-Null
    [Win32Capture]::DeleteDC($memDC) | Out-Null
    [Win32Capture]::ReleaseDC($WindowHandle, $srcDC) | Out-Null

    Write-Host "  [截图] 已保存到 $OutputPath" -ForegroundColor Green
    Write-Host "  [截图] 窗口区域：$($rect.Left),$($rect.Top) ${width}x${height}" -ForegroundColor Gray
}

# ─── 5. 像素采样（窗口底部区域，通常是输入框/按钮区） ────────
function Sample-WindowPixels {
    param([System.IntPtr]$WindowHandle)

    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32Pixel {
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("gdi32.dll")]
        public static extern int GetPixel(IntPtr hdc, int x, int y);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    }
"@

    $rect = New-Object Win32Pixel+RECT
    [Win32Pixel]::GetWindowRect($WindowHandle, [ref]$rect) | Out-Null

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top

    $dc = [Win32Pixel]::GetDC($WindowHandle)

    # 采样关键区域的像素颜色
    # 区域 1：窗口底部中央（通常是输入框/发送按钮区）
    $samples = @()
    $samplePoints = @(
        @{ X = [int]($width * 0.5);  Y = [int]($height * 0.95); Label = "底部中央（发送按钮区）" }
        @{ X = [int]($width * 0.85); Y = [int]($height * 0.95); Label = "底部右侧（按钮区）" }
        @{ X = [int]($width * 0.5);  Y = [int]($height * 0.88); Label = "底部上方（输入框）" }
        @{ X = [int]($width * 0.5);  Y = [int]($height * 0.5);  Label = "窗口中央（内容区）" }
        @{ X = [int]($width * 0.1);  Y = [int]($height * 0.5);  Label = "窗口左侧" }
        @{ X = [int]($width * 0.5);  Y = [int]($height * 0.05); Label = "顶部中央" }
    )

    foreach ($sp in $samplePoints) {
        $colorRef = [Win32Pixel]::GetPixel($dc, $sp.X, $sp.Y)
        $r = $colorRef -band 0xFF
        $g = ($colorRef -shr 8) -band 0xFF
        $b = ($colorRef -shr 16) -band 0xFF
        $hex = "#{0:X2}{1:X2}{2:X2}" -f $r, $g, $b
        $samples += [PSCustomObject]@{
            Position = "$($sp.X),$($sp.Y)"
            Label = $sp.Label
            Color = $hex
            RGB = "$r,$g,$b"
        }
    }

    [Win32Pixel]::ReleaseDC($WindowHandle, $dc) | Out-Null
    return $samples
}

# ═══════════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════════
Write-Host "=== TRAE Work 状态诊断工具 ===" -ForegroundColor Cyan
Write-Host ""

$traeProcess = Find-TraeWindow
if (-not $traeProcess) {
    Write-Host "[错误] 未找到 TRAE Work 窗口，请确认已打开" -ForegroundColor Red
    exit 1
}

Write-Host "找到窗口：$($traeProcess.MainWindowTitle)" -ForegroundColor Green
Write-Host "进程 PID：$($traeProcess.Id)" -ForegroundColor Gray
Write-Host "窗口句柄：$($traeProcess.MainWindowHandle)" -ForegroundColor Gray
Write-Host ""

# ── 截图模式 ──
if ($TakeScreenshot) {
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $screenshotPath = Join-Path $desktopPath "trae-work-screenshot.png"
    Write-Host "--- 截图模式 ---" -ForegroundColor Cyan
    Take-WindowScreenshot -WindowHandle $traeProcess.MainWindowHandle -OutputPath $screenshotPath
    Write-Host ""
}

# ── 首次诊断 ──
function Run-Diagnostic {
    param([System.Diagnostics.Process]$Process, [int]$PollIndex = -1)

    if ($PollIndex -ge 0) {
        Write-Host "--- 轮询 #$PollIndex ($(Get-Date -Format 'HH:mm:ss')) ---" -ForegroundColor Cyan
    } else {
        Write-Host "--- 一次性诊断 ---" -ForegroundColor Cyan
    }

    # (A) UI Automation 元素枚举
    Write-Host "`n[A] UI Automation 元素扫描：" -ForegroundColor Yellow
    $elements = Get-UIElements -WindowHandle $Process.MainWindowHandle
    if ($elements.Count -gt 0) {
        Write-Host "  找到 $($elements.Count) 个元素：" -ForegroundColor Green
        $elements | Format-Table -AutoSize | Out-String | Write-Host

        # 智能搜索关键元素
        $stopButtons = $elements | Where-Object { $_.Name -match "stop|cancel|Stop|Cancel|停止|取消|终止" }
        $sendButtons = $elements | Where-Object { $_.Name -match "send|发送|submit|提交" }
        $inputFields = $elements | Where-Object { $_.Type -match "Edit" -or $_.ClassName -match "input|textarea|editor" }

        if ($stopButtons.Count -gt 0) {
            Write-Host "  [!] 发现停止/取消按钮（可能正在生成）：" -ForegroundColor Red
            $stopButtons | ForEach-Object { Write-Host "      $($_.Name) [$($_.ClassName)]" -ForegroundColor Red }
        } else {
            Write-Host "  [OK] 未发现停止按钮（可能处于空闲状态）" -ForegroundColor Green
        }
        if ($sendButtons.Count -gt 0) {
            Write-Host "  [i] 发现发送按钮：" -ForegroundColor Cyan
            $sendButtons | ForEach-Object { Write-Host "      $($_.Name) [$($_.ClassName)]" -ForegroundColor Cyan }
        }
        if ($inputFields.Count -gt 0) {
            Write-Host "  [i] 发现输入框：" -ForegroundColor Cyan
            $inputFields | ForEach-Object { Write-Host "      $($_.Name) [$($_.ClassName)] enabled=$($_.IsEnabled)" -ForegroundColor Cyan }
        }
    } else {
        Write-Host "  未获取到 UI 元素（Electron 可能未完全暴露可访问性树）" -ForegroundColor Yellow
    }

    # (B) 像素采样
    Write-Host "`n[B] 窗口像素采样：" -ForegroundColor Yellow
    $pixels = Sample-WindowPixels -WindowHandle $Process.MainWindowHandle
    $pixels | Format-Table -AutoSize | Out-String | Write-Host

    # (C) 网络状态
    Write-Host "`n[C] 网络连接状态：" -ForegroundColor Yellow
    $net = Get-NetworkBytes -ProcessId $Process.Id
    Write-Host "  活跃 TCP 连接：$($net.ActiveConnections)" -ForegroundColor $(if ($net.ActiveConnections -gt 3) { "Green" } else { "Gray" })
    Write-Host "  总 TCP 连接：$($net.TotalConnections)" -ForegroundColor Gray

    # (D) CPU 使用率
    Write-Host "`n[D] 进程资源：" -ForegroundColor Yellow
    $cpu = try { $Process.CPU } catch { "N/A" }
    $mem = [Math]::Round($Process.WorkingSet64 / 1MB, 1)
    Write-Host "  CPU 时间：$cpu 秒" -ForegroundColor Gray
    Write-Host "  内存占用：$mem MB" -ForegroundColor Gray

    Write-Host ""
}

if ($Continuous) {
    Write-Host "=== 持续轮询模式（每 ${PollIntervalMs}ms，最多 $MaxPolls 次）===" -ForegroundColor Cyan
    Write-Host "提示：在轮询期间，请在 TRAE Work 中交替执行"发送消息"和"等待完成"操作" -ForegroundColor Yellow
    Write-Host "      观察哪些指标在生成中/空闲状态之间有明显变化" -ForegroundColor Yellow
    Write-Host ""

    for ($i = 0; $i -lt $MaxPolls; $i++) {
        # 刷新进程信息
        $traeProcess = Find-TraeWindow
        if (-not $traeProcess) {
            Write-Host "[轮询中断] 窗口已关闭" -ForegroundColor Red
            break
        }
        Run-Diagnostic -Process $traeProcess -PollIndex $i
        if ($i -lt $MaxPolls - 1) {
            Start-Sleep -Milliseconds $PollIntervalMs
        }
    }
} else {
    Run-Diagnostic -Process $traeProcess
}

Write-Host "=== 诊断完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "  1. 对比"生成中"和"空闲"两个状态下的像素/元素/网络数据" -ForegroundColor Gray
Write-Host "  2. 找到有明显差异的指标 → 即可作为状态检测信号" -ForegroundColor Gray
Write-Host "  3. 用 -TakeScreenshot 截图查看窗口布局" -ForegroundColor Gray
