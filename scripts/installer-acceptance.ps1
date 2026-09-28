#Requires -Version 7
<#
issue #41 的「卸载路径」真机验收：装 → 断言 → 卸 → 断言。

# ⚠ 为什么它必须跑在 CI 上
开发机（Windows 11 + 火绒 + EasyAntiCheat 的内核过滤驱动）上，**新编译的未签名安装器**被
**按可执行文件**拦截：同一上下文里 `cmd`（微软签名）能建目录、能往 C 盘写同一个 6.9 MB 的 exe、
能写 `HKCU\Software\Classes` 键，而**同一个安装器三件事全做不到**（退出码 0 却什么都没写）。
同一套 makensis 编的 **20 行最小安装器**症状完全一致，而同一个安装器**写 D 盘却完整成功** ——
所以这与我们的打包无关，但本机就是完不成这条验收。原始测量见
`docs/probes/mac-deeplink/FINDINGS.md` §7.1；CI 的 windows-latest 没有这个拦截。

# 判据（逐条对应 issue #41 的验收标准）
1. 安装后自有类键 `HKCU\Software\Classes\<scheme>` 存在，且 `shell\open\command` 指向安装出来的 exe；
2. 安装器写的 `Uninstall\<product>` 条目存在 —— 它是「Install 段跑到底」的证据（失败会静默半途而废）；
3. **卸载后该键消失** ← 本脚本存在的理由（NSIS_HOOK_POSTUNINSTALL + 模板自带判据）；
4. 全程 `HKCU\Software\Classes\vrcx`（模拟既有 VRCX 自己的类键）**逐字节不变** ← 「绝不碰外来键」。

# ⚠ 为什么第 4 条要在这里测
真机上「外来键不被碰」的真正证据是：安装/卸载**真的跑过一遍**之后，别人的键一个字节都没变。
单测只能覆盖判据（`registration_verdict` 的真值表 + 真实注册表夹具），覆盖不了"安装器整体行为"。
⚠ 对照的两半必须分清：**读写对照**用本脚本自有的探测名（可随便删建）；**既有的 `vrcx` 键只做只读比对** ——
这条规则是踩过坑才立的：本脚本最初直接删建 `HKCU\Software\Classes\vrcx`，在开发机上把用户真实的 VRCX
注册改成了假的（已用快照恢复）。见下方 `$foreignKey` 处的注释。
#>
[CmdletBinding()]
param(
  # 安装包所在目录（相对仓库根）；找不到就直接失败，不猜。
  [string]$BundleDir = 'target/release/bundle/nsis',
  # 声明的 scheme / 产品名，与 tauri.conf.json 保持一致。
  [string]$Scheme = 'vrcxk',
  [string]$Product = 'vrcx-k',
  # 轮询上限（秒）。安装/卸载是同步等待的，这里只是给杀软扫描留余量。
  [int]$TimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$failures = [System.Collections.Generic.List[string]]::new()
function Say([string]$Message) { Write-Host $Message }
function Check([bool]$Condition, [string]$Message) {
  if ($Condition) { Say "PASS: $Message" } else { Say "FAIL: $Message"; $failures.Add($Message) }
}
function Stage([string]$Title) { Say ''; Say ('#' * 8 + " $Title " + '#' * 8) }

function Get-RegistryExport([string]$Key, [string]$Path) {
  if (-not (Test-Path $Key)) { return '<absent>' }
  # ⚠ reg.exe 只认原生 hive 写法（HKCU\…），PowerShell 的 HKCU:\… 会被它判为 "Invalid key name"。
  $nativeKey = $Key -replace '^HKCU:\\', 'HKCU\' -replace '^HKLM:\\', 'HKLM\'
  & reg.exe export $nativeKey $Path /y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "reg export failed for $nativeKey (exit $LASTEXITCODE)" }
  return Get-Content -Raw $Path
}

# ⚠ StrictMode 下 `(Get-ItemProperty …).'缺失的值'` 会**抛异常**，把"键没写成"这种预期内的失败
# 变成脚本崩溃 —— 那样后面的断言就全跑不到、失败清单也不完整。统一走这个安全取值。
function Get-RegValue([string]$Key, [string]$Name) {
  if (-not (Test-Path $Key)) { return $null }
  # 默认值在 PowerShell 注册表提供程序里的名字是字面量 '(default)'；**空字符串会直接绑定失败**
  # （`Get-ItemProperty -Name ''`），而这个异常会在 ErrorActionPreference=Stop 下中断整个脚本 ——
  # 本地那次键不存在、这条分支没走到，所以是 CI 上第一次真正取默认值时才炸出来的。
  if ([string]::IsNullOrEmpty($Name)) { $Name = '(default)' }
  $item = Get-ItemProperty -Path $Key -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  $property = $item.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Wait-For([scriptblock]$Probe, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Probe) { return $true }
    Start-Sleep -Seconds 2
  }
  return [bool](& $Probe)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$snapDir = Join-Path $repoRoot '.temp/installer-acceptance'
New-Item -ItemType Directory -Force $snapDir | Out-Null

$ownKey = "HKCU:\Software\Classes\$Scheme"
$ownKeyNative = "HKCU\Software\Classes\$Scheme"
$foreignKey = 'HKCU:\Software\Classes\vrcx-acceptance-foreign'
# ⚠ 对照键必须是**我们自己的名字**，且只能由本脚本创建/删除。
# 这里最初用的是 `HKCU\Software\Classes\vrcx` —— 那是**既有 VRCX 真正在用的键**。脚本会"先删再建"，
# 于是本地冒烟时把开发机上真实的 VRCX 注册（DefaultIcon 指向 VRCX-Luo 的图标、shell 默认值 open）
# 删掉、换成了假的 `C:\fake\vrcx.exe`；CI 上是干净机器所以完全看不出来，本机上是实打实的破坏
# （已用测试前的逐字节快照恢复并校验）。
# ⇒ 想验证"别人的键不被碰"，正确做法是：① 用一个**明确属于本脚本**的探测名做读写对照；
#   ② 对真实存在的键只做**只读**导出比对（$realVrcxKey），绝不去动它。
$realVrcxKey = 'HKCU:\Software\Classes\vrcx'   # 既有 VRCX 自己的键：只读，一个字节都不许变
$uninstallEntry = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Product"
$installDir = Join-Path $env:LOCALAPPDATA $Product

Stage '0. 找到安装包'
$installer = Get-ChildItem (Join-Path $repoRoot $BundleDir) -Filter '*setup.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Check ($null -ne $installer) "找到 NSIS 安装包（$BundleDir）"
if (-not $installer) {
  Say '没有任何安装包可测 —— 构建步骤失败或路径不对，直接失败而不是跳过。'
  exit 1
}
Say "installer: $($installer.FullName) ($([math]::Round($installer.Length / 1MB, 1)) MiB)"

Stage '1. 铺对照：一个属于本脚本的探测键 + 一份既有 vrcx 键的只读快照'
# ① 读写对照：名字明确属于本脚本，删/建都只影响它自己。
if (Test-Path $foreignKey) { Remove-Item $foreignKey -Recurse -Force }
New-Item -Path "$foreignKey\shell\open\command" -Force | Out-Null
Set-ItemProperty $foreignKey -Name 'URL Protocol' -Value ''
Set-ItemProperty "$foreignKey\shell\open\command" -Name '(default)' -Value '"C:\fake\vrcx.exe" "%1"'
$foreignBefore = Get-RegistryExport $foreignKey (Join-Path $snapDir 'foreign-before.reg')
Check ($foreignBefore -ne '<absent>') '对照键（本脚本自有名字）已建立'
# ② 只读对照：既有 VRCX 自己的键。可能不存在（CI 干净机器），那就记录 '<absent>' 并同样比对。
$realBefore = Get-RegistryExport $realVrcxKey (Join-Path $snapDir 'real-vrcx-before.reg')
Say "  既有 vrcx 键的起始状态: $(if ($realBefore -eq '<absent>') { '不存在（干净机器）' } else { '存在，已快照' })"

Stage '2. 静默安装'
if (Test-Path $ownKey) { Remove-Item $ownKey -Recurse -Force }
if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }
$proc = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
Say "installer exit code: $($proc.ExitCode)"
Check ($proc.ExitCode -eq 0) '安装器退出码为 0'

Stage '3. 安装后的断言'
$ownCommand = "$ownKey\shell\open\command"
$ownKeyInstalled = Wait-For { Test-Path $ownKey } $TimeoutSeconds
Check $ownKeyInstalled "自有类键 $ownKeyNative 出现"
$commandValue = if (Test-Path $ownCommand) { Get-RegValue $ownCommand '' } else { '' }
Say "  shell\open\command = $commandValue"
$expectedExe = Join-Path $installDir 'tauri-app.exe'
Check ($commandValue -like "*$expectedExe*") "命令串指向安装出来的 exe（$expectedExe）"
Check (Test-Path $expectedExe) '安装目录里确实有那个 exe 文件'
Check ((Get-RegValue $ownKey 'URL Protocol') -ne $null) `
  '自有类键带 URL Protocol 值（Windows 认它是协议处理器）'
Check (Test-Path $uninstallEntry) '安装器写了 Uninstall 条目（Install 段跑到了底）'
$foreignAfterInstall = Get-RegistryExport $foreignKey (Join-Path $snapDir 'foreign-after-install.reg')
Check ($foreignBefore -eq $foreignAfterInstall) '安装后，对照键（本脚本自有名字）逐字节未变'
$realAfterInstall = Get-RegistryExport $realVrcxKey (Join-Path $snapDir 'real-vrcx-after-install.reg')
Check ($realBefore -eq $realAfterInstall) '安装后，既有的 vrcx 类键逐字节未变（只读对照）'

Stage '4. 静默卸载'
$uninstaller = Join-Path $installDir 'uninstall.exe'
Check (Test-Path $uninstaller) "卸载器存在（$uninstaller）"
if (Test-Path $uninstaller) {
  $proc = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  Say "uninstaller exit code: $($proc.ExitCode)"
}

Stage '5. 卸载后的断言（本脚本存在的理由）'
# ⚠ 「键不在了」在键**从未被创建**时同样成立 —— 那样这一条会空过成 PASS，正是本仓库反复踩过的假绿。
# 所以先要求安装阶段真的写出来过；没写成就是"无法验证"，按 FAIL 记，绝不按 PASS 记。
if (-not $ownKeyInstalled) {
  Check $false "卸载后自有类键 $ownKeyNative 被删 —— ⚠ 无法验证：安装阶段就没写成（上面已 FAIL），此时「键不在了」不构成证据"
} else {
  Check (Wait-For { -not (Test-Path $ownKey) } $TimeoutSeconds) `
    "卸载后自有类键 $ownKeyNative 确实被删（acceptance criterion）"
}
if (Test-Path $ownKey) {
  Get-ChildItem $ownKey -Recurse | Select-Object -ExpandProperty Name | ForEach-Object { Say "  leftover: $_" }
  Say "  shell\open\command = $(Get-RegValue $ownCommand '')"
}
if (-not $ownKeyInstalled) {
  Check $false '卸载后 Uninstall 条目也不在了 —— ⚠ 同上：安装阶段就没有这个条目'
} else {
  Check (-not (Test-Path $uninstallEntry)) '卸载后 Uninstall 条目也不在了'
}
$foreignAfterUninstall = Get-RegistryExport $foreignKey (Join-Path $snapDir 'foreign-after-uninstall.reg')
Check ($foreignBefore -eq $foreignAfterUninstall) '卸载后，对照键（本脚本自有名字）仍然逐字节未变'
$realAfterUninstall = Get-RegistryExport $realVrcxKey (Join-Path $snapDir 'real-vrcx-after-uninstall.reg')
Check ($realBefore -eq $realAfterUninstall) '卸载后，既有的 vrcx 类键仍然逐字节未变（只读对照）'

Stage '6. 结论'
if ($failures.Count -gt 0) {
  Say "### VERDICT: FAILURES ($($failures.Count)) ###"
  $failures | ForEach-Object { Say "  - $_" }
  exit 1
}
Say '### VERDICT: all assertions passed ###'
exit 0
