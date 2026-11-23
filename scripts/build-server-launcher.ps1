param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$sourceRoot = Join-Path $projectRoot 'launcher/windows'
if (!$OutputPath) { $OutputPath = Join-Path $projectRoot 'release/Yingjian-Server.exe' }
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path $OutputPath -Parent) -Force | Out-Null
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
if (!(Test-Path -LiteralPath (Join-Path $framework 'csc.exe'))) { $framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319' }
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 64,64
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(185,243,228))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(23,61,50)),3.5
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(23,61,50))
$graphics.DrawRectangle($pen,12,13,40,15)
$graphics.DrawRectangle($pen,12,36,40,15)
$graphics.FillEllipse($brush,18,18,5,5)
$graphics.FillEllipse($brush,18,41,5,5)
$graphics.DrawLine($pen,32,20,45,20)
$graphics.DrawLine($pen,32,43,45,43)
$iconPath = Join-Path $sourceRoot 'server.ico'
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconStream = [System.IO.File]::Create($iconPath)
try { $icon.Save($iconStream) } finally { $iconStream.Dispose(); $graphics.Dispose(); $pen.Dispose(); $brush.Dispose(); $bitmap.Dispose() }
$references = @(
  'System.dll','System.Core.dll','System.Xaml.dll','System.Web.Extensions.dll',
  'System.Net.Http.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll',
  'System.Drawing.dll','System.Windows.Forms.dll',
  (Join-Path $framework 'WPF/WindowsBase.dll'),
  (Join-Path $framework 'WPF/PresentationCore.dll'),
  (Join-Path $framework 'WPF/PresentationFramework.dll')
)
$arguments = @('/nologo','/target:winexe','/platform:anycpu','/optimize+','/utf8output',
  "/out:$OutputPath", "/win32icon:$iconPath", "/win32manifest:$(Join-Path $sourceRoot 'app.manifest')",
  "/resource:$(Join-Path $sourceRoot 'Launcher.xaml'),Launcher.xaml")
$arguments += $references | ForEach-Object { "/reference:$_" }
$arguments += Join-Path $sourceRoot 'Launcher.cs'
& (Join-Path $framework 'csc.exe') @arguments
if ($LASTEXITCODE -ne 0) { throw 'Windows 服务端启动器编译失败。' }
[System.IO.File]::WriteAllText("$OutputPath.config", @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <startup useLegacyV2RuntimeActivationPolicy="true"><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.7.2"/></startup>
  <runtime><AppContextSwitchOverrides value="Switch.System.Windows.DoNotScaleForDpiChanges=false"/></runtime>
</configuration>
'@, (New-Object System.Text.UTF8Encoding $false))
Get-Item -LiteralPath $OutputPath | Select-Object FullName, Length
