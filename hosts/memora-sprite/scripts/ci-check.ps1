# ci-check.ps1 - Local CI simulation script
#
# Purpose: Simulates GitHub Actions CI pipeline locally before commit,
#          avoiding repeated push-triggered CI failures.
# Usage:   Run from repo root:  powershell -File hosts/memora-sprite/scripts/ci-check.ps1
# Prereq:  npm install / npm ci already done locally
#
# CI steps (aligned with .github/workflows/build.yml):
#   1. Force fix filename casing (fix TS1261)
#   2. Sync memora kernel (npm run sync-memora)
#   3. Type check Electron (npx tsc -p tsconfig.electron.json --noEmit)
#   4. Type check Web (npx tsc -p tsconfig.web.json --noEmit)
#   5. Lint (npm run lint)
#   6. Unit tests (npx vitest run)
#   7. Dependency audit (npm audit --audit-level=high)

$script:spriteDir = [System.IO.Path]::Combine($PWD, "hosts", "memora-sprite")
$script:baseDir = [System.IO.Path]::Combine($spriteDir, "src", "electron", "renderer", "components", "base")

if (-not (Test-Path $spriteDir)) {
    Write-Host "[ERROR] hosts/memora-sprite not found. Run from repo root." -ForegroundColor Red
    exit 1
}

$script:stepNum = 0
$script:totalSteps = 7
$script:failed = $false

function Step-Header {
    param([string]$Title)
    $script:stepNum++
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  [$($script:stepNum)/$script:totalSteps] $Title" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
}

function Run-Step {
    param([string]$Title, [scriptblock]$ScriptBlock)
    Step-Header $Title
    & $ScriptBlock
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] $Title (exit code: $LASTEXITCODE)" -ForegroundColor Red
        $script:failed = $true
    } else {
        Write-Host "[PASS] $Title" -ForegroundColor Green
    }
}

# ========================================
# Step 1: Force fix filename casing
# ========================================
Run-Step -Title "Force fix filename casing (fix TS1261)" -ScriptBlock {
    $lowerPath = [System.IO.Path]::Combine($baseDir, "component.ts")

    # Windows 大小写不敏感，Component.ts 和 component.ts 是同一个文件，无需修正
    # 该修正仅对 CI 的 Linux/macOS 环境有意义
    if (-not (Test-Path $lowerPath)) {
        Write-Host "  [WARN] component.ts not found! Check git status." -ForegroundColor Yellow
    } else {
        Write-Host "  component.ts exists, no fix needed on Windows (case-insensitive FS)"
    }
    exit 0
}

if ($script:failed) { exit 1 }

# ========================================
# Step 2: Sync memora kernel
# ========================================
Run-Step -Title "Sync memora kernel" -ScriptBlock {
    Push-Location $spriteDir
    npm run sync-memora 2>&1
    $exitCode = $LASTEXITCODE
    Pop-Location
    exit $exitCode
}

if ($script:failed) { exit 1 }

# ========================================
# Step 3: Type check (Electron)
# ========================================
Run-Step -Title "Type check (Electron)" -ScriptBlock {
    Push-Location $spriteDir
    npx tsc -p tsconfig.electron.json --noEmit 2>&1
    $exitCode = $LASTEXITCODE
    Pop-Location
    exit $exitCode
}

if ($script:failed) { exit 1 }

# ========================================
# Step 4: Type check (Web)
# ========================================
Run-Step -Title "Type check (Web)" -ScriptBlock {
    Push-Location $spriteDir
    npx tsc -p tsconfig.web.json --noEmit 2>&1
    $exitCode = $LASTEXITCODE
    Pop-Location
    exit $exitCode
}

if ($script:failed) { exit 1 }

# ========================================
# Step 5: Lint
# ========================================
Run-Step -Title "Lint" -ScriptBlock {
    Push-Location $spriteDir
    npm run lint 2>&1
    $exitCode = $LASTEXITCODE
    Pop-Location
    exit $exitCode
}

if ($script:failed) { exit 1 }

# ========================================
# Step 6: Unit tests
# ========================================
Run-Step -Title "Unit tests" -ScriptBlock {
    Push-Location $spriteDir
    npx vitest run 2>&1
    $exitCode = $LASTEXITCODE
    Pop-Location
    exit $exitCode
}

if ($script:failed) { exit 1 }

# ========================================
# Step 7: Dependency audit
# ========================================
Run-Step -Title "Dependency audit" -ScriptBlock {
    Push-Location $spriteDir
    npm audit --audit-level=high 2>&1
    $exitCode = $LASTEXITCODE
    Pop-Location
    if ($exitCode -ne 0) {
        Write-Host "  [WARN] High-risk vulnerabilities found (non-blocking, CI uses continue-on-error)" -ForegroundColor Yellow
    }
    exit 0
}

# ========================================
# Summary
# ========================================
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  CI simulation complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  All $script:totalSteps steps passed!" -ForegroundColor Green
exit 0