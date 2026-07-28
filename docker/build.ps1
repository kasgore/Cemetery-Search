# Rebuilds docker\cemetery-search-build.tar — the Portainer build context.
# Run:  powershell -File build.ps1   (from this folder, or double-click)
# Then: Portainer > Images > Build a new image > name cemetery-search:latest
#       > upload the tar > deploy/update the stack (docker/cemetery-search-stack.yml).
#
# Layout inside the tar: Dockerfile at root beside the app files — exactly
# the build context docker/Dockerfile expects. Uses Windows' native tar.exe
# (bsdtar), the archive dialect Portainer accepts (same recipe as the
# Stocks project's working build.ps1).
$ErrorActionPreference = "Stop"
$proj = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $env:TEMP "cemetery-search-stage"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

# App files (the Dockerfile's COPY list)
$files = @(
  "requirements.txt", "app.py", "refresher.py",
  "index.html", "cemetery-search.html",
  "app-core.js", "app-map.js", "app-ui.js",
  "cemetery-data.js", "xlsx.full.min.js",
  "sw.js", "manifest.webmanifest"
)
foreach ($f in $files) { Copy-Item (Join-Path $proj $f) $stage }
foreach ($d in @("icons", "geometry", "seed")) {
  robocopy (Join-Path $proj $d) (Join-Path $stage $d) /E | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $d failed: $LASTEXITCODE" }
}
Copy-Item "$PSScriptRoot\Dockerfile" "$stage\Dockerfile"

tar -cf "$PSScriptRoot\cemetery-search-build.tar" -C $stage .
if ($LASTEXITCODE -ne 0) { throw "tar failed" }
$t = Get-Item "$PSScriptRoot\cemetery-search-build.tar"
"Built {0} ({1:N1} MB)" -f $t.Name, ($t.Length / 1MB)
