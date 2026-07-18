# 通过 P/Invoke 调用 Windows user32.dll 获取前台窗口标题（UTF-16，解决中文乱码）
# 用于 quick-input 浮窗的 captureActiveWindow，替代 nut-js 的 ANSI 乱码 title
# 调用方：inputInjector.ts readElectronFocusedWindowTitle()
# 输出：标题字符串（UTF-8 stdout），无标题或失败时输出空字符串

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class ForegroundWindow {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    public static string GetTitle() {
        IntPtr hWnd = GetForegroundWindow();
        if (hWnd == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(512);
        int length = GetWindowTextW(hWnd, sb, sb.Capacity);
        return length > 0 ? sb.ToString() : "";
    }
}
"@

# 输出标题到 stdout（PowerShell 默认 UTF-8 编码，确保中文等非 ASCII 字符正确输出）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output -NoEnumerate ([ForegroundWindow]::GetTitle())
