param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('letter', 'mount', 'image', 'writeback', 'status')]
  [string]$Action,
  [string]$Image = 'D:\fish-handoff\sd\sd-full.img'
)
# 大肥鱼 → 树莓派 SD 卡，交接用脚本。以管理员身份运行。
$ErrorActionPreference = 'Continue'
$log = 'D:\fish-handoff\scripts\sd.log'
function W($m) { Add-Content -Path $log -Value ([string]$m) -Encoding UTF8 }
$DISK = 2

W ("=== {0} action={1} ===" -f (Get-Date -Format 'HH:mm:ss'), $Action)

function Show-Status {
  $d = Get-Disk -Number $DISK -ErrorAction SilentlyContinue
  if (-not $d) { W 'Disk 2 不存在（卡拔了？）'; return }
  W ("disk{0}: {1} status={2} offline={3} size={4:N2}GB" -f $DISK, $d.FriendlyName, $d.OperationalStatus, $d.IsOffline, ($d.Size/1GB))
  Get-Partition -DiskNumber $DISK -ErrorAction SilentlyContinue |
    ForEach-Object { W ("  p{0} {1} {2} {3:N2}GB" -f $_.PartitionNumber, $_.DriveLetter, $_.Type, ($_.Size/1GB)) }
}

switch ($Action) {

  'status' { Show-Status }

  # 把 H: 还给卡（WSL 挂盘前必须摘掉，挂完可以加回来）
  'letter' {
    Set-Disk -Number $DISK -IsOnline $true -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    try {
      Add-PartitionAccessPath -DiskNumber $DISK -PartitionNumber 1 -AccessPath 'H:\' -ErrorAction Stop
      W 'H: 已恢复'
    } catch { W ('恢复 H: 失败: ' + $_.Exception.Message) }
    Show-Status
  }

  # 把整张卡交给 WSL（bare），失败则自动退回镜像路线
  'mount' {
    Show-Status
    try {
      $p = Get-Partition -DiskNumber $DISK -PartitionNumber 1 -ErrorAction Stop
      if ($p.DriveLetter) {
        Remove-PartitionAccessPath -DiskNumber $DISK -PartitionNumber 1 -AccessPath "$($p.DriveLetter):\" -ErrorAction Stop
        W ("已摘掉 {0}: 盘符" -f $p.DriveLetter)
      }
    } catch { W ('摘盘符失败: ' + $_.Exception.Message) }

    foreach ($mode in @(@('--bare'), @('--partition', '2'))) {
      $args = @('--mount', '\\.\PHYSICALDRIVE' + $DISK) + $mode
      W ('wsl ' + ($args -join ' '))
      $out = & wsl.exe @args 2>&1
      W (($out | Out-String).Trim())
      W ("exit=$LASTEXITCODE")
      if ($LASTEXITCODE -eq 0) {
        W '--- WSL 里的块设备 ---'
        W ((& wsl.exe -d Ubuntu -u root -- bash -lc "lsblk -o NAME,SIZE,FSTYPE,LABEL" | Out-String).Trim())
        break
      }
    }
  }

  # 整盘读成镜像（不动卡），后续所有改动都在镜像里做
  'image' {
    $d = Get-Disk -Number $DISK -ErrorAction SilentlyContinue
    if (-not $d) { W 'Disk 2 不存在'; break }
    $total = [int64]$d.Size
    New-Item -ItemType Directory -Force -Path (Split-Path $Image) | Out-Null
    $free = (Get-PSDrive D).Free
    W ("镜像 {0} 需要 {1:N1}GB，D: 剩 {2:N1}GB" -f $Image, ($total/1GB), ($free/1GB))
    if ($free -lt ($total + 1GB)) { W 'D: 空间不够'; break }
    $t0 = Get-Date
    try {
      $src = [IO.File]::Open('\\.\PHYSICALDRIVE' + $DISK, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      $dst = [IO.File]::Create($Image)
      $buf = New-Object byte[] (8MB)
      $done = [int64]0
      while ($done -lt $total) {
        $want = [int]([Math]::Min([int64]$buf.Length, $total - $done))
        $n = $src.Read($buf, 0, $want)
        if ($n -le 0) { break }
        $dst.Write($buf, 0, $n); $done += $n
        if (($done % (1GB)) -lt $buf.Length) {
          $el = ((Get-Date) - $t0).TotalSeconds
          W ("  {0:N0}MB / {1:N0}MB  {2:N1}MB/s" -f ($done/1MB), ($total/1MB), (($done/1MB)/$el))
        }
      }
      $dst.Flush(); $dst.Close(); $src.Close()
      W ("镜像完成 {0:N2}GB，用时 {1:N0}s" -f ((Get-Item $Image).Length/1GB), ((Get-Date)-$t0).TotalSeconds)
    } catch { W ('镜像失败: ' + $_.Exception.Message) }
  }

  # 把镜像写回卡（危险动作，先确认镜像完好）
  # 换新系统镜像烧盘也是走这里：-Image 指向那个 .img 就行（.img.xz 要先解开）。
  'writeback' {
    if (-not (Test-Path $Image)) { W "镜像不存在: $Image"; break }
    $d = Get-Disk -Number $DISK -ErrorAction SilentlyContinue
    if (-not $d) { W 'Disk 2 不存在'; break }
    # 卡现在可能还是 Offline（摘过盘符），写之前拉回 online
    Set-Disk -Number $DISK -IsOnline $true -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    $len = (Get-Item $Image).Length
    if ($len -gt $d.Size) { W ("镜像 {0:N2}GB 比卡 {1:N2}GB 大，写不完，停。" -f ($len/1GB), ($d.Size/1GB)); break }
    if ($len -lt 100MB) { W ("镜像只有 {0:N1}MB，像选错文件了，停。" -f ($len/1MB)); break }
    $head = New-Object byte[] 512
    $fs = [IO.File]::OpenRead($Image); [void]$fs.Read($head, 0, 512); $fs.Close()
    $isMbr = ($head[510] -eq 0x55 -and $head[511] -eq 0xAA)
    W ("镜像: {0}  {1:N2}GB  分区表: {2}" -f $Image, ($len/1GB), $(if ($isMbr) { 'MBR' } else { '不是 MBR（可能是 GPT，或根本不是镜像，自己确认）' }))
    W ("目标: disk{0}  {1}  {2:N2}GB" -f $DISK, $d.FriendlyName, ($d.Size/1GB))
    W '确认无误后 10 秒内可 Ctrl+C 取消...'
    Start-Sleep -Seconds 10
    $t0 = Get-Date
    try {
      $src = [IO.File]::OpenRead($Image)
      $dst = [IO.File]::Open('\\.\PHYSICALDRIVE' + $DISK, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
      $buf = New-Object byte[] (8MB)
      $done = [int64]0
      while ($done -lt $len) {
        $n = $src.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $dst.Write($buf, 0, $n); $done += $n
        if (($done % (1GB)) -lt $buf.Length) {
          $el = ((Get-Date) - $t0).TotalSeconds
          W ("  {0:N0}MB / {1:N0}MB  {2:N1}MB/s" -f ($done/1MB), ($len/1MB), (($done/1MB)/$el))
        }
      }
      $dst.Flush(); $dst.Close(); $src.Close()
      W ("写回完成，用时 {0:N0}s" -f ((Get-Date)-$t0).TotalSeconds)
    } catch { W ('写回失败: ' + $_.Exception.Message) }
    W '建议：拔出再插一次，然后跑 -Action letter 恢复 H: 验证能读'
  }
}
