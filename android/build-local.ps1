param(
    [string]$JdkPath = $env:JAVA_HOME,
    [string]$SdkPath = $env:ANDROID_HOME,
    [string]$GradlePath,
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$projectPath = $PSScriptRoot
if (-not $JdkPath -or -not (Test-Path -LiteralPath (Join-Path $JdkPath 'bin/java.exe'))) { throw 'Specify -JdkPath pointing to a JDK 17 installation.' }
if (-not $SdkPath -or -not (Test-Path -LiteralPath (Join-Path $SdkPath 'platforms/android-35/android.jar'))) { throw 'Specify -SdkPath with Android SDK Platform 35 and Build Tools 35.0.0 installed.' }
$env:JAVA_HOME = (Resolve-Path -LiteralPath $JdkPath).Path
$env:ANDROID_HOME = (Resolve-Path -LiteralPath $SdkPath).Path
$env:ANDROID_USER_HOME = Join-Path $projectPath '.android-user'
$env:GRADLE_USER_HOME = Join-Path $projectPath '.gradle-home'
New-Item -ItemType Directory -Path (Join-Path $projectPath '.signing') -Force | Out-Null
$signingPath = Join-Path $projectPath '.signing/debug.keystore'
if (-not (Test-Path -LiteralPath $signingPath)) {
    & (Join-Path $env:JAVA_HOME 'bin/keytool.exe') -genkeypair -keystore $signingPath -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Android Debug,O=Android,C=US'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create local debug signing key.' }
}
# Gradle reads ANDROID_HOME; no machine-specific local.properties is required in source packages.
$gradleCommand = if ($GradlePath) { Join-Path $GradlePath 'bin/gradle.bat' } else { Join-Path $projectPath 'gradlew.bat' }
if (-not (Test-Path -LiteralPath $gradleCommand)) { throw 'Gradle executable not found.' }
$gradleArgs = @('--no-daemon', ':app:assemblePhoneDebug', ':app:assembleTvDebug')
if ($Offline) { $gradleArgs = @('--offline') + $gradleArgs }
Push-Location $projectPath
try {
    & $gradleCommand @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed.' }
} finally { Pop-Location }
Write-Host 'Phone: app/build/outputs/apk/phone/debug/app-phone-debug.apk'
Write-Host 'TV:    app/build/outputs/apk/tv/debug/app-tv-debug.apk'
