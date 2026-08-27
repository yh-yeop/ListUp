# ListUp 을 이 PC에서 실행하고 Cloudflare 빠른 터널로 공개한다.
#
#   powershell -ExecutionPolicy Bypass -File deploy-tunnel.ps1
#
# - 터널 URL 은 실행할 때마다 바뀐다 (trycloudflare.com 임시 도메인).
# - 창을 닫거나 Ctrl+C 를 누르면 공개가 중단된다.
# - Windows PowerShell 5.1 호환 (&& 없음).
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# 1. 토큰 서명 키 — 없으면 만들어 server/data 에 보관한다 (gitignore 대상).
#    키가 바뀌면 전원 로그아웃되므로 파일로 고정한다.
$secretFile = Join-Path $root 'server\data\auth-secret.txt'
if (-not (Test-Path $secretFile)) {
  New-Item -ItemType Directory -Force (Split-Path $secretFile) | Out-Null
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" |
    Out-File -Encoding ascii $secretFile
}
$env:LISTUP_AUTH_SECRET = (Get-Content $secretFile -Raw).Trim()
$env:NODE_ENV = 'production'

# 2. 웹 번들이 없거나 다른 설정으로 빌드됐으면 빌드한다.
#    EXPO_PUBLIC_LISTUP_API_URL=/ 는 "API 를 같은 오리진에서 상대 경로로 불러라"는 뜻.
#    (Git Bash 에서는 / 가 Windows 경로로 변환돼 깨지므로 반드시 PowerShell 에서 빌드)
#
#    번들 안의 문자열로는 판정할 수 없다 — app.json 이 통째로 번들에 들어가므로 정상 빌드에도
#    extra.listupApiUrl 의 'localhost:4000' 이 남는다. 그래서 빌드가 끝나면 어떤 주소로
#    만들었는지 도장 파일에 적어 두고, 그걸 보고 판단한다.
#    (dist 안의 숨김 파일은 서버가 서빙하지 않는다 — app.ts 의 dotfiles: 'ignore')
$apiUrl = '/'
$distDir = Join-Path $root 'app\dist'
$stampFile = Join-Path $distDir '.listup-api-url'
$needBuild = $true
if ((Test-Path (Join-Path $distDir 'index.html')) -and (Test-Path $stampFile)) {
  if ((Get-Content $stampFile -Raw).Trim() -eq $apiUrl) { $needBuild = $false }
  else { Write-Host '웹 번들이 다른 서버 주소로 빌드돼 있습니다 — 다시 빌드합니다.' }
}
if ($needBuild) {
  $env:EXPO_PUBLIC_LISTUP_API_URL = $apiUrl
  npm run build:web --workspace "@listup/app" -- --clear
  if ($LASTEXITCODE -ne 0) { throw '웹 빌드 실패' }
  # expo export 가 dist 를 비우므로 도장은 빌드 뒤에 찍는다.
  Out-File -FilePath $stampFile -Encoding ascii -InputObject $apiUrl
}

# 3. 서버를 별도 창으로 띄우고 (http://localhost:4000), 뜰 때까지 기다린다.
#    바로 앞에서 웹 빌드를 돌렸으면 머신이 바빠 tsx 첫 기동에 1분 가까이 걸리기도 한다.
Start-Process -WorkingDirectory (Join-Path $root 'server') -FilePath 'cmd' `
  -ArgumentList '/k', 'npm run start'

$healthUrl = 'http://localhost:4000/api/health'
$healthy = $false
Write-Host "서버가 뜨기를 기다립니다 ($healthUrl) …"
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 1
  try {
    $res = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
    if ($res.StatusCode -eq 200) { $healthy = $true; break }
  } catch {
    # 아직 안 떴거나 200 이 아니면 다시 시도한다.
  }
}
if (-not $healthy) {
  Write-Host "서버가 90초 안에 뜨지 않았습니다 ($healthUrl). 서버 창의 오류를 확인하세요. 터널은 열지 않습니다." -ForegroundColor Red
  exit 1
}

# 4. 터널을 연다. 출력에 나오는 https://….trycloudflare.com 이 공개 주소다.
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cloudflared) { $cf = $cloudflared.Source }
else { $cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
& $cf tunnel --url http://localhost:4000 --no-autoupdate
