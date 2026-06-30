# 设置国内镜像环境变量（用户级）
# 用途：为 electron、electron-builder、better-sqlite3 配置国内镜像源，加速二进制下载
# 用法：在项目根目录执行 ./scripts/setup-mirrors.ps1
# 注意：设置后需重新打开终端或刷新环境变量才能生效

# 镜像地址配置
$envVars = @{
    # Electron 二进制镜像（@electron/get 读取此环境变量）
    "ELECTRON_MIRROR" = "https://npmmirror.com/mirrors/electron/"
    # electron-builder 二进制镜像
    "ELECTRON_BUILDER_BINARIES_MIRROR" = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    # better-sqlite3 预编译二进制镜像（prebuild-install / @lwahdr/better-sqlite3 读取）
    "BETTER_SQLITE3_BINARY_HOST" = "https://npmmirror.com/mirrors/better-sqlite3/"
}

Write-Host "=== Memora Sprite - 国内镜像配置工具 ===" -ForegroundColor Cyan
Write-Host ""

foreach ($key in $envVars.Keys) {
    $value = $envVars[$key]
    $currentValue = [Environment]::GetEnvironmentVariable($key, "User")

    if ($currentValue -eq $value) {
        Write-Host "[已存在] $key = $value" -ForegroundColor Gray
    } else {
        # 设置用户级环境变量（永久生效，不需要管理员权限）
        [Environment]::SetEnvironmentVariable($key, $value, "User")
        Write-Host "[已设置] $key = $value" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "=== 配置完成 ===" -ForegroundColor Cyan
Write-Host "提示：请重新打开终端窗口，或执行以下命令刷新当前会话：" -ForegroundColor Yellow
Write-Host "  `$env:ELECTRON_MIRROR = '$($envVars["ELECTRON_MIRROR"])'"
Write-Host "  `$env:ELECTRON_BUILDER_BINARIES_MIRROR = '$($envVars["ELECTRON_BUILDER_BINARIES_MIRROR"])'"
Write-Host "  `$env:BETTER_SQLITE3_BINARY_HOST = '$($envVars["BETTER_SQLITE3_BINARY_HOST"])'"
Write-Host ""
Write-Host "然后重新运行：npm install" -ForegroundColor Yellow
