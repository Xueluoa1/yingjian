param([Parameter(Mandatory=$true)][string]$PackageRoot, [Parameter(Mandatory=$true)][string]$OutputRoot)
$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $OutputRoot) { throw 'Choose a fresh test output directory.' }
[void][IO.Directory]::CreateDirectory($OutputRoot)
$launcher = Join-Path $PackageRoot 'Yingjian-Server.exe'
$oldRoot = $env:YINGJIAN_LAUNCHER_ROOT
$checks = [ordered]@{}
function Need([bool]$value, [string]$message) { if (!$value) { throw $message } }
function Run-Launcher([string]$root, [string[]]$arguments) {
  $env:YINGJIAN_LAUNCHER_ROOT = $root
  $process = Start-Process -FilePath $launcher -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (!$process.WaitForExit(60000)) { throw 'Launcher test exceeded 60 seconds.' }
  $process.Refresh()
  Need ($process.ExitCode -eq 0) ('Launcher failed: ' + $process.ExitCode)
}
function Hash-Stream($stream) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
try {
  $before = @(Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -Force | ForEach-Object { $_.FullName } | Sort-Object)
  $fixture = Join-Path $OutputRoot 'self-test'
  foreach ($path in @('server','public','config')) { [void][IO.Directory]::CreateDirectory((Join-Path $fixture $path)) }
  Run-Launcher $fixture @('--self-test')
  $self = Get-Content -LiteralPath (Join-Path $fixture 'launcher-self-test.json') -Raw | ConvertFrom-Json
  Need ($self.ok -and $self.checks -ge 35) 'Launcher self tests failed.'
  $checks.selfTest = $self.checks
  $layout = Join-Path $OutputRoot 'layout'
  Run-Launcher $PackageRoot @('--window-layout-test','--output-dir',('"' + $layout + '"'))
  foreach ($name in @('local','nas-amd64','nas-arm64')) {
    Need ((Get-Item -LiteralPath (Join-Path $layout "launcher-$name-layout.png")).Length -gt 1000) 'Layout rendering missing.'
  }
  $checks.offlineWpfLayout = $true
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start(); $testPort = $listener.LocalEndpoint.Port; $listener.Stop()
  Need ($testPort -ne 8080) 'Refusing normal service port.'
  $smokePath = Join-Path $OutputRoot 'service-smoke.json'
  Run-Launcher $PackageRoot @('--smoke-test','--port',$testPort,'--data-dir',('"' + (Join-Path $OutputRoot 'service-data') + '"'),'--output',('"' + $smokePath + '"'))
  $smoke = Get-Content -LiteralPath $smokePath -Raw | ConvertFrom-Json
  Need ($smoke.ok -and $smoke.stopped) 'Packaged service did not start and stop cleanly.'
  $checks.windowsService = @{ passed=$true; port=$testPort; isolatedData=$true; stopped=$true }

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $assembly = [Reflection.Assembly]::LoadFrom($launcher)
  $flags = [Reflection.BindingFlags]'Static,NonPublic'
  $program = $assembly.GetType('Yingjian.ServerLauncher.Program')
  $program.GetField('Root',$flags).SetValue($null, $PackageRoot + '\')
  $core = $assembly.GetType('Yingjian.ServerLauncher.LauncherCore')
  $method = $core.GetMethods($flags) | Where-Object { $_.Name -eq 'ExportNas' -and $_.GetParameters().Count -eq 6 }
  $export = $method.CreateDelegate([Func[string,string,int,string,string,string,string]])
  $exports = Join-Path $OutputRoot 'exports'
  [void][IO.Directory]::CreateDirectory($exports)
  foreach ($arch in @('amd64','arm64')) {
    $folder = $export.Invoke($exports,'192.168.1.8',8080,'Synthetic$Only#Password','fixture-volume',$arch)
    $name = [IO.Path]::GetFileName($folder)
    $offline = Test-Path -LiteralPath (Join-Path $PackageRoot "deployment/nas-offline/$arch/image.tar")
    $expectedMode = if ($offline) { 'Offline' } else { 'Source' }
    Need ($name -like "Yingjian-NAS-$expectedMode-$arch-*") 'Wrong architecture or export mode in filename.'
    $compose = [IO.File]::ReadAllText((Join-Path $folder 'docker-compose.yml'))
    if ($offline) {
      Need (!(Test-Path -LiteralPath (Join-Path $folder 'Dockerfile'))) 'Offline package must not build.'
      $original = Join-Path $PackageRoot "deployment/nas-offline/$arch"
      foreach ($file in Get-ChildItem -LiteralPath $original -File -Force) {
        Need ((Get-FileHash -LiteralPath $file.FullName).Hash -eq (Get-FileHash -LiteralPath (Join-Path $folder $file.Name)).Hash) 'Offline file bytes changed.'
      }
      $report = Get-Content -LiteralPath (Join-Path $folder 'verification.json') -Raw | ConvertFrom-Json
      Need ($report.image.platform -ceq "linux/$arch") 'Exported image has the wrong platform.'
    } else {
      Need (!(Test-Path -LiteralPath (Join-Path $folder 'image.tar'))) 'Source mode must not borrow another architecture image.'
      Need ([IO.File]::ReadAllText((Join-Path $folder 'target-platform.txt')) -ceq "linux/$arch`n") 'Source target mismatch.'
      Need ($compose -cmatch "(?m)^    platform: linux/$arch$") 'Source Compose architecture mismatch.'
      Need (Test-Path -LiteralPath (Join-Path $folder 'server/index.js')) 'Source server missing.'
    }
    $config = [IO.File]::ReadAllText((Join-Path $folder '.env'))
    Need ($config.Contains('ADMIN_PASSWORD=''Synthetic$Only#Password''') -and $config.Contains("DATA_VOLUME='fixture-volume'") -and !$config.Contains("`r")) 'Generated configuration changed literal values or LF encoding.'
    $files = @(Get-ChildItem -LiteralPath $folder -Recurse -File -Force)
    $zip = [IO.Compression.ZipFile]::OpenRead($folder + '.zip')
    try {
      Need ($zip.Entries.Count -eq $files.Count) 'ZIP file count differs from export directory.'
      foreach ($entry in $zip.Entries) {
        Need ($entry.FullName.StartsWith($name + '/') -and !$entry.FullName.Contains('\') -and !$entry.FullName.Contains('/../')) 'Invalid ZIP path.'
        $relative = $entry.FullName.Substring($name.Length + 1)
        $stream = $entry.Open()
        try { Need ((Hash-Stream $stream) -eq (Get-FileHash -LiteralPath (Join-Path $folder $relative)).Hash.ToLowerInvariant()) 'ZIP bytes differ from exported files.' }
        finally { $stream.Dispose() }
      }
    } finally { $zip.Dispose() }
    $checks[$arch] = @{ mode=$expectedMode; passed=$true; zipMatchesFiles=$true; configuration=$true }
  }
  $after = @(Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -Force | ForEach-Object { $_.FullName } | Sort-Object)
  Need (($before -join "`n") -ceq ($after -join "`n")) 'Tests wrote inside packaged directory.'
  $checks.packageFileListUnchanged = $true
  $result = @{ passed=$true; checks=$checks }
} catch { $result = @{ passed=$false; checks=$checks; error=$_.Exception.Message }; throw }
finally {
  $env:YINGJIAN_LAUNCHER_ROOT = $oldRoot
  [IO.File]::WriteAllText((Join-Path $OutputRoot 'results.json'), ($result | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
}
$result | ConvertTo-Json -Depth 6
