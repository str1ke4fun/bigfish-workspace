Write-Host "找大肥鱼当前地址…" -ForegroundColor Cyan
try {
    $log = (& wsl.exe -u root cat /home/str1k3/dsh-web.log 2>$null) -join "`n"
} catch { $log = "" }

if ($log -match 'token=([A-Za-z0-9_-]+)') {
    $url = "http://127.0.0.1:8710/?token=$($Matches[1])"
    Write-Host "  $url" -ForegroundColor Green
    Start-Process $url
} else {
    Write-Host "没在日志里找到 token。" -ForegroundColor Yellow
    Write-Host "服务状态：" -ForegroundColor Yellow
    & wsl.exe -u root systemctl status dsh-web --no-pager -n 12
    Write-Host "`n如果服务没起，试：wsl -u root systemctl restart dsh-web" -ForegroundColor Yellow
}
