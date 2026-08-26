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

# 2. 웹 번들이 없거나 잘못 빌드됐으면 빌드한다.
#    EXPO_PUBLIC_LISTUP_API_URL=/ 는 "API 를 같은 오리진에서 상대 경로로 불러라"는 뜻.
#    (Git Bash 에서는 / 가 Windows 경로로 변환돼 깨지므로 반드시 PowerShell 에서 빌드)
#    번들에 'localhost:4000' 이 박혀 있으면 절대 URL 로 잘못 빌드된 것이라 다시 만든다.
$distDir = Join-Path $root 'app\dist'
$bundleDir = Join-Path $distDir '_expo\static\js\web'
$needBuild = $false
if (-not (Test-Path (Join-Path $distDir 'index.html'))) {
  $needBuild = $true
} elseif (-not (Test-Path $bundleDir)) {
  Write-Host '웹 번들 디렉터리가 없습니다 — 다시 빌드합니다.'
  $needBuild = $true
} else {
  foreach ($bundle in Get-ChildItem -Path $bundleDir -Filter '*.js') {
    if (Select-String -Path $bundle.FullName -Pattern 'localhost:4000' -SimpleMatch -Quiet) {
      Write-Host "웹 번들에 localhost:4000 이 박혀 있습니다 ($($bundle.Name)) — 다시 빌드합니다."
      $needBuild = $true
      break
    }
  }
}
if ($needBuild) {
  $env:EXPO_PUBLIC_LISTUP_API_URL = '/'
  npm run build:web --workspace "@listup/app" -- --clear
  if ($LASTEXITCODE -ne 0) { throw '웹 빌드 실패' }
}

# 3. 서버를 별도 창으로 띄우고 (http://localhost:4000), 뜰 때까지 최대 30초 기다린다.
Start-Process -WorkingDirectory (Join-Path $root 'server') -FilePath 'cmd' `
  -ArgumentList '/k', 'npm run start'

$healthUrl = 'http://localhost:4000/api/health'
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $res = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
    if ($res.StatusCode -eq 200) { $healthy = $true; break }
  } catch {
    # 아직 안 떴거나 200 이 아니면 다시 시도한다.
  }
}
if (-not $healthy) {
  Write-Host "서버가 30초 안에 뜨지 않았습니다 ($healthUrl). 서버 창의 오류를 확인하세요. 터널은 열지 않습니다." -ForegroundColor Red
  exit 1
}

# 4. 터널을 연다. 출력에 나오는 https://….trycloudflare.com 이 공개 주소다.
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cloudflared) { $cf = $cloudflared.Source }
else { $cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
& $cf tunnel --url http://localhost:4000 --no-autoupdate
