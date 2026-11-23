using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace Yingjian.ServerLauncher {
  internal static class Program {
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal static string Root;
    [STAThread]
    public static int Main(string[] args) {
      Root = Path.GetFullPath(Environment.GetEnvironmentVariable("YINGJIAN_LAUNCHER_ROOT") ?? AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
      if (args.Contains("--self-test")) return SelfTest();
      if (args.Contains("--smoke-test")) return SmokeTest(args).GetAwaiter().GetResult();
      if (args.Contains("--window-layout-test")) return RenderLayouts(args);
      bool created;
      string key;
      using (var sha = SHA256.Create()) key = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Root.ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
      using (var mutex = new Mutex(true, @"Local\YingjianServer_" + key, out created)) {
        if (!created) { MessageBox.Show("映间服务端启动器已经打开，请在系统托盘中打开窗口。", "映间服务端"); return 0; }
        try {
          var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
          app.Run(new MainWindow());
          return 0;
        } catch (Exception ex) { MessageBox.Show(ex.Message, "映间服务端启动器"); return 1; }
        finally { mutex.ReleaseMutex(); }
      }
    }
    internal static string Arg(string[] args, string name, string fallback) {
      var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : fallback;
    }
    static int SelfTest() {
      try {
        int checks = 0;
        Action<bool, string> check = (ok, name) => { if (!ok) throw new Exception(name); checks++; };
        check(LauncherCore.ValidPort("8080") == 8080, "port");
        check(LauncherCore.IsPrivateIPv4("192.168.2.20"), "private IPv4");
        check(!LauncherCore.IsPrivateIPv4("8.8.8.8") && !LauncherCore.IsPrivateIPv4("127.0.0.1") && !LauncherCore.IsPrivateIPv4("192.168.1.01"), "reject non-LAN");
        check(LauncherCore.PasswordValid("abc$#987654321") && !LauncherCore.PasswordValid("12345678901") && !LauncherCore.PasswordValid("abc'123456789") && !LauncherCore.PasswordValid("abc\\123456789") && !LauncherCore.PasswordValid("replace-with-your-own-password"), "password");
        check(LauncherCore.BuildEnv("192.168.1.8", 8090, "abc$#987654321", "existing-data").Contains("ADMIN_PASSWORD='abc$#987654321'"), "literal env");
        check(LauncherCore.VolumeValid("yingjian-data") && !LauncherCore.VolumeValid("../data"), "volume");
        check(LauncherCore.ValidateDataDirectory(Path.Combine(Root, "data")) == Path.Combine(Root, "data"), "default data directory");
        Action<Action, string> rejects = (run, label) => { bool rejected = false; try { run(); } catch (ArgumentException) { rejected = true; } check(rejected, label); };
        rejects(() => LauncherCore.ValidateDataDirectory(Root), "reject root data directory");
        foreach (var folder in new[] { "public", "config", "server", "launcher", "deployment", "runtime", "node_modules" }) {
          rejects(() => LauncherCore.ValidateDataDirectory(Path.Combine(Root, folder, "new-data")), "reject data in " + folder);
        }
        foreach (var folder in new[] { "public", "config", "server" }) {
          rejects(() => LauncherCore.ValidateExportParent(Path.Combine(Root, folder, "exports")), "reject recursive export in " + folder);
          var directory = Path.Combine(Root, folder);
          int beforeCount = Directory.GetFileSystemEntries(directory).Length;
          rejects(() => LauncherCore.ExportNas(directory, "192.168.1.20", 8080, "test-only-password", "test-volume"), "reject export before write in " + folder);
          check(Directory.GetFileSystemEntries(directory).Length == beforeCount, "no export output in " + folder);
        }
        rejects(() => LauncherCore.StartHost(18090, Path.Combine(Root, "public"), line => { }).GetAwaiter().GetResult(), "reject unsafe host before start");
        check(LauncherCore.ValidateExportParent(Root) == LauncherCore.NormalizeDirectory(Root), "root export allowed");
        var xaml = ReadXaml(); check(xaml.Contains("映间服务端") && !xaml.Contains("播放影片"), "server UI");
        // Parse resources and named controls without showing a window or starting the service.
        var view = (Window)XamlReader.Parse(xaml);
        check(view.FindName("StartButton") != null && view.FindName("ExportButton") != null, "XAML controls");
        view.Close();
        var shell = new MainWindow(true);
        check(shell.FindName("ChangeDataButton") != null && shell.Content != null, "window initialization");
        shell.Close();
        File.WriteAllText(Path.Combine(Root, "launcher-self-test.json"), Json.Serialize(new { ok = true, checks = checks, time = DateTime.UtcNow.ToString("o") }), Encoding.UTF8);
        return 0;
      } catch (Exception ex) {
        File.WriteAllText(Path.Combine(Root, "launcher-self-test.json"), Json.Serialize(new { ok = false, error = ex.Message }), Encoding.UTF8); return 1;
      }
    }
    static int RenderLayouts(string[] args) {
      try {
        string output = Path.GetFullPath(Arg(args, "--output-dir", Path.Combine(Root, "test-results", "launcher-layout")));
        Directory.CreateDirectory(output);
        var window = new MainWindow(true);
        foreach (bool nas in new[] { false, true }) {
          window.ShowTab(nas);
          ((TextBlock)window.FindName("Notice")).Text = "离线布局检查 · 此图不代表服务运行或实际窗口交互结果";
          var content = (FrameworkElement)window.Content;
          var size = new Size(1064, 751);
          content.Measure(size); content.Arrange(new Rect(size)); content.UpdateLayout();
          var bitmap = new System.Windows.Media.Imaging.RenderTargetBitmap((int)size.Width, (int)size.Height, 96, 96, PixelFormats.Pbgra32);
          bitmap.Render(content);
          var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
          encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bitmap));
          using (var stream = File.Create(Path.Combine(output, nas ? "launcher-nas-layout.png" : "launcher-local-layout.png"))) encoder.Save(stream);
        }
        window.Close();
        File.WriteAllText(Path.Combine(output, "layout-test.json"), Json.Serialize(new { ok = true, kind = "offline WPF rendering, not interactive desktop QA" }), Encoding.UTF8);
        return 0;
      } catch (Exception) { return 1; }
    }
    static async Task<int> SmokeTest(string[] args) {
      var output = Arg(args, "--output", Path.Combine(Root, "launcher-smoke-test.json"));
      var port = LauncherCore.ValidPort(Arg(args, "--port", "18089"));
      var data = Path.GetFullPath(Arg(args, "--data-dir", Path.Combine(Root, "test-results", "launcher-smoke-data")));
      Process child = null;
      var events = new List<string>();
      try {
        if (port == 8080) throw new Exception("Smoke test refuses the normal service port.");
        var before = await LauncherCore.Probe(port);
        if (before.Reachable || LauncherCore.PortOccupied(port)) throw new Exception("Test port is already occupied.");
        child = await LauncherCore.StartHost(port, data, line => { lock (events) events.Add(LauncherCore.CleanLog(line)); });
        Status ready = null;
        for (int i = 0; i < 50; i++) {
          if (child.HasExited) throw new Exception("Host exited before becoming ready.");
          ready = await LauncherCore.Probe(port);
          if (ready.IsYingjian) break;
          await Task.Delay(300);
        }
        if (ready == null || !ready.IsYingjian) throw new Exception("Host did not become ready.");
        if (!await LauncherCore.StopHost(child)) throw new Exception("Host did not stop gracefully.");
        if (child.ExitCode != 0) throw new Exception("Host failed while stopping. Exit code: " + child.ExitCode);
        lock (events) if (!events.Contains("服务已安全停止。")) throw new Exception("Host did not confirm a safe shutdown.");
        var after = await LauncherCore.Probe(port);
        if (after.Reachable) throw new Exception("Service still responds after shutdown.");
        File.WriteAllText(output, Json.Serialize(new { ok = true, port = port, data = data, version = ready.Version, stopped = true, events = events.ToArray() }), Encoding.UTF8);
        return 0;
      } catch (Exception ex) {
        if (child != null && !child.HasExited) LauncherCore.StopHost(child).GetAwaiter().GetResult();
        File.WriteAllText(output, Json.Serialize(new { ok = false, error = ex.Message, events = events.ToArray() }), Encoding.UTF8); return 1;
      } finally { if (child != null) child.Dispose(); }
    }
    internal static string ReadXaml() {
      using (var stream = typeof(Program).Assembly.GetManifestResourceStream("Launcher.xaml"))
      using (var reader = new StreamReader(stream)) return reader.ReadToEnd();
    }
  }

  internal sealed class Status {
    internal bool Reachable;
    internal bool IsYingjian;
    internal string Version = "";
    internal string[] Addresses = new string[0];
    internal int Sources;
  }
  internal static class LauncherCore {
    static readonly string[] ProgramDirectories = { "public", "config", "server", "launcher", "deployment", "runtime", "node_modules", "scripts", "tests", "android", "ui", ".git", ".codex", ".agents" };
    internal static string NormalizeDirectory(string value) {
      string full = Path.GetFullPath(value);
      string root = Path.GetPathRoot(full);
      return full.Length > root.Length ? full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : root;
    }
    static bool IsWithin(string path, string parent) {
      path = NormalizeDirectory(path); parent = NormalizeDirectory(parent);
      return String.Equals(path, parent, StringComparison.OrdinalIgnoreCase) || path.StartsWith(parent.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }
    static void RejectReparseAncestors(string value) {
      string path = NormalizeDirectory(value);
      while (!String.IsNullOrEmpty(path)) {
        if (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("请选择实际文件夹，不能使用符号链接或目录联接。");
        string next = Path.GetDirectoryName(path);
        if (String.Equals(next, path, StringComparison.OrdinalIgnoreCase)) break;
        path = next;
      }
    }
    static void RejectProgramData(string path, string package) {
      if (String.Equals(path, NormalizeDirectory(package), StringComparison.OrdinalIgnoreCase) || ProgramDirectories.Any(folder => IsWithin(path, Path.Combine(package, folder))))
        throw new ArgumentException("数据目录不能放在程序目录中。请选择 data 文件夹，或其他独立的数据文件夹。");
    }
    internal static string ValidateDataDirectory(string value) {
      string path = NormalizeDirectory(value);
      RejectReparseAncestors(path);
      RejectProgramData(path, Program.Root);
      // Also protect another unpacked installation if its data directory is selected.
      string ancestor = path;
      while (!String.IsNullOrEmpty(ancestor)) {
        if (File.Exists(Path.Combine(ancestor, "package.json")) && Directory.Exists(Path.Combine(ancestor, "server")) && Directory.Exists(Path.Combine(ancestor, "public"))) RejectProgramData(path, ancestor);
        string next = Path.GetDirectoryName(ancestor);
        if (String.Equals(next, ancestor, StringComparison.OrdinalIgnoreCase)) break;
        ancestor = next;
      }
      return path;
    }
    internal static string ValidateExportParent(string value) {
      string path = NormalizeDirectory(value);
      RejectReparseAncestors(path);
      if (new[] { "server", "public", "config" }.Any(folder => IsWithin(path, Path.Combine(Program.Root, folder))))
        throw new ArgumentException("不能将部署包导出到 server、public、config 或它们的子目录。请选择其他保存位置。");
      return path;
    }
    internal static int ValidPort(string value) {
      int result;
      if (!Int32.TryParse(value, out result) || result < 1 || result > 65535) throw new ArgumentException("端口请填写 1–65535 之间的数字。");
      return result;
    }
    internal static bool IsPrivateIPv4(string value) {
      IPAddress address;
      if (!IPAddress.TryParse(value, out address) || address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork || address.ToString() != value) return false;
      byte[] b = address.GetAddressBytes();
      return b[0] == 10 || b[0] == 172 && b[1] >= 16 && b[1] <= 31 || b[0] == 192 && b[1] == 168;
    }
    internal static bool PasswordValid(string value) {
      return value.Length >= 12 && value.Length <= 128 && value != "replace-with-your-own-password" && value.All(c => c >= 32 && c <= 126 && c != '\'' && c != '"' && c != '\\') && value.Trim().Length >= 12;
    }
    internal static bool VolumeValid(string value) { return Regex.IsMatch(value, @"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$"); }
    internal static string BuildEnv(string ip, int port, string password, string volume) {
      if (!IsPrivateIPv4(ip)) throw new ArgumentException("请填写 NAS 的局域网 IPv4 地址，例如 192.168.1.20。");
      ValidPort(port.ToString());
      if (!PasswordValid(password)) throw new ArgumentException("管理密码需要 12–128 个英文字符、数字或符号，不能包含引号、反斜杠或换行。");
      if (!VolumeValid(volume)) throw new ArgumentException("数据卷名称只能包含英文、数字、短横线、下划线和点，并以英文或数字开头。");
      return "# Generated by Yingjian Server Launcher. Keep this file private.\n" +
        "ADMIN_PASSWORD='" + password + "'\nLAN_BIND_IP='" + ip + "'\nHOST_PORT='" + port + "'\nPUBLIC_ORIGIN='http://" + ip + ":" + port + "'\nDATA_VOLUME='" + volume + "'\n";
    }
    internal static async Task<Status> Probe(int port) {
      var result = new Status();
      try {
        using (var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(1600), MaxResponseContentBufferSize = 1024 * 1024 }) {
          using (var response = await client.GetAsync("http://127.0.0.1:" + port + "/api/status").ConfigureAwait(false)) {
            result.Reachable = true;
            if (!response.IsSuccessStatusCode) return result;
            var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            var obj = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
            object name;
            result.IsYingjian = obj != null && obj.TryGetValue("name", out name) && Convert.ToString(name) == "映间";
            if (!result.IsYingjian) return result;
            object value;
            if (obj.TryGetValue("version", out value)) result.Version = Convert.ToString(value);
            if (obj.TryGetValue("enabledSourceCount", out value)) result.Sources = Convert.ToInt32(value);
            if (obj.TryGetValue("addresses", out value)) {
              var values = value as System.Collections.IEnumerable;
              if (values != null) {
                var addresses = new List<string>();
                foreach (var item in values) {
                  Uri uri;
                  var candidate = Convert.ToString(item);
                  if (Uri.TryCreate(candidate, UriKind.Absolute, out uri) && uri.Scheme == "http" && IsPrivateIPv4(uri.Host) && uri.Port == port) addresses.Add(candidate.TrimEnd('/'));
                }
                result.Addresses = addresses.Distinct().ToArray();
              }
            }
          }
        }
      } catch { }
      return result;
    }
    internal static bool PortOccupied(int port) {
      try { return System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(p => p.Port == port); }
      catch { return false; }
    }
    internal static string CleanLog(string line) {
      if (line == null) return "";
      try {
        var entry = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
        object type, message;
        if (entry.TryGetValue("type", out type)) {
          if (Convert.ToString(type) == "ready") return "服务已就绪。";
          if (entry.TryGetValue("message", out message)) line = Convert.ToString(message);
          else return Convert.ToString(type) == "stopped" ? "服务已安全停止。" : "";
        }
      } catch { }
      line = Regex.Replace(line, @"(?i)(password|token|secret|pair|code)(\s*[:=]\s*)([^\s,&]+)", "$1$2[已隐藏]");
      return line.Length > 2000 ? line.Substring(0, 2000) : line;
    }
    internal static async Task<Process> StartHost(int port, string data, Action<string> onLine) {
      data = ValidateDataDirectory(data);
      string host = Path.Combine(Program.Root, "launcher", "host.mjs");
      if (!File.Exists(host)) throw new FileNotFoundException("缺少服务文件 launcher\\host.mjs，请重新解压完整的服务端安装包。");
      string runtime = Path.Combine(Program.Root, "runtime", "node.exe");
      if (!File.Exists(runtime)) runtime = FindNode();
      if (runtime == null) throw new FileNotFoundException("没有找到 Node.js 22 或更新版本。请使用包含运行环境的 Windows 服务端包。");
      var versionStart = new ProcessStartInfo(runtime, "--version") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
      using (var version = Process.Start(versionStart)) {
        string output = await version.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
        string error = await version.StandardError.ReadToEndAsync().ConfigureAwait(false);
        await Task.Run(() => version.WaitForExit()).ConfigureAwait(false);
        Match match = Regex.Match(output.Trim(), @"^v(\d+)\.");
        if (!match.Success || Int32.Parse(match.Groups[1].Value) < 22) throw new Exception("当前 Node.js 版本过旧，需要 Node.js 22 或更新版本。");
      }
      var info = new ProcessStartInfo(runtime, Quote(host) + " --port " + port + " --data-dir " + Quote(Path.GetFullPath(data))) {
        WorkingDirectory = Program.Root, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
      };
      var process = new Process { StartInfo = info, EnableRaisingEvents = true };
      process.OutputDataReceived += (sender, e) => { if (e.Data != null) onLine(e.Data); };
      process.ErrorDataReceived += (sender, e) => { if (e.Data != null) onLine(e.Data); };
      process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
      return process;
    }
    internal static async Task<bool> StopHost(Process process) {
      if (process == null || process.HasExited) return true;
      try { await process.StandardInput.WriteLineAsync("{\"command\":\"shutdown\"}").ConfigureAwait(false); await process.StandardInput.FlushAsync().ConfigureAwait(false); }
      catch (IOException) { }
      catch (InvalidOperationException) { }
      return await Task.Run(() => {
        if (!process.WaitForExit(30000)) return false;
        process.WaitForExit(); // Drain redirected output after the exit notification.
        return true;
      }).ConfigureAwait(false);
    }
    internal static string Quote(string value) {
      // Every argument here is an absolute Windows path; embedded quotes are invalid.
      if (value.Contains("\"")) throw new ArgumentException("路径不能包含双引号。");
      int trailing = value.Length - value.TrimEnd('\\').Length;
      return "\"" + value + new string('\\', trailing) + "\"";
    }
    static string FindNode() {
      foreach (var part in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) {
        try { var path = Path.Combine(part.Trim('"'), "node.exe"); if (File.Exists(path)) return path; } catch { }
      }
      return null;
    }
    internal static bool HasOfflineImage() {
      return File.Exists(Path.Combine(Program.Root, "deployment", "nas-offline", "image.tar"));
    }
    internal static readonly string[] OfflineFiles = {
      "image.tar", "image-metadata.txt", "image.tar.sha256", "verification.json", "manifest.json",
      "docker-compose.yml", ".env.example", "deploy.sh", "README.md", "THIRD-PARTY.md"
    };
    static void ValidateOfflineImage() {
      string runtime = Path.Combine(Program.Root, "runtime", "node.exe");
      if (!File.Exists(runtime)) runtime = FindNode();
      string verifier = Path.Combine(Program.Root, "scripts", "verify-nas-offline.mjs");
      if (runtime == null || !File.Exists(verifier)) throw new IOException("离线镜像校验工具缺失，请重新解压完整服务端包。");
      string bundle = Path.Combine(Program.Root, "deployment", "nas-offline");
      var info = new ProcessStartInfo(runtime, Quote(verifier) + " " + Quote(bundle)) {
        UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
      };
      using (var process = Process.Start(info)) {
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        Task.WaitAll(stdout, stderr);
        if (process.ExitCode != 0) throw new IOException("离线镜像校验未通过：" + stderr.Result.Trim());
        var report = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(stdout.Result);
        object ok;
        if (report == null || !report.TryGetValue("ok", out ok) || !Object.Equals(ok, true))
          throw new IOException("离线镜像校验没有返回成功结果。");
      }
    }
    internal static string ExportNas(string parent, string ip, int port, string password, string volume) {
      parent = ValidateExportParent(parent);
      var env = BuildEnv(ip, port, password, volume);
      bool offline = HasOfflineImage();
      if (offline) ValidateOfflineImage();
      var name = (offline ? "Yingjian-NAS-Offline-" : "Yingjian-NAS-Source-") + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 4);
      var folder = Path.Combine(parent, name);
      if (Directory.Exists(folder) || File.Exists(folder + ".zip")) throw new IOException("目标已存在，请选择其他导出目录。");
      foreach (var item in offline ? new string[0] : new[] { "server", "public", "config" })
        if (!Directory.Exists(Path.Combine(Program.Root, item))) throw new IOException("缺少服务目录：" + item);
      var templates = new[] { "Dockerfile", "docker-compose.yml", ".dockerignore", "deploy.sh", "README.md", ".env.example" };
      foreach (var item in offline ? new string[0] : templates)
        if (!File.Exists(Path.Combine(Program.Root, "deployment", "nas", item))) throw new IOException("缺少 NAS 部署文件：" + item);
      try {
        Directory.CreateDirectory(folder);
        if (offline) {
          foreach (var item in OfflineFiles) File.Copy(Path.Combine(Program.Root, "deployment", "nas-offline", item), Path.Combine(folder, item), false);
        } else {
          foreach (var item in new[] { "server", "public", "config" }) CopyDirectory(Path.Combine(Program.Root, item), Path.Combine(folder, item));
          foreach (var item in new[] { "package.json", "package-lock.json" }) File.Copy(Path.Combine(Program.Root, item), Path.Combine(folder, item), false);
          var thirdParty = Path.Combine(Program.Root, "THIRD-PARTY.md");
          if (File.Exists(thirdParty)) File.Copy(thirdParty, Path.Combine(folder, "THIRD-PARTY.md"), false);
          foreach (var item in templates) File.WriteAllText(Path.Combine(folder, item), File.ReadAllText(Path.Combine(Program.Root, "deployment", "nas", item)).Replace("\r\n", "\n"), new UTF8Encoding(false));
        }
        File.WriteAllText(Path.Combine(folder, ".env"), env, new UTF8Encoding(false));
        using (var zip = ZipFile.Open(folder + ".zip", ZipArchiveMode.Create)) {
          foreach (var file in Directory.GetFiles(folder, "*", SearchOption.AllDirectories)) zip.CreateEntryFromFile(file, name + "/" + file.Substring(folder.Length + 1).Replace('\\', '/'), CompressionLevel.Optimal);
        }
        return folder;
      } catch {
        // Only remove this newly created export, never a parent or an existing data volume.
        string resolvedParent = NormalizeDirectory(parent);
        string resolvedFolder = Path.GetFullPath(folder);
        if (String.Equals(NormalizeDirectory(Path.GetDirectoryName(resolvedFolder)), resolvedParent, StringComparison.OrdinalIgnoreCase) && Path.GetFileName(resolvedFolder) == name) {
          try { if (File.Exists(resolvedFolder + ".zip")) File.Delete(resolvedFolder + ".zip"); } catch { }
          try { if (Directory.Exists(resolvedFolder)) Directory.Delete(resolvedFolder, true); } catch { }
        }
        throw;
      }
    }
    static void CopyDirectory(string source, string target) {
      if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("部署目录不能包含符号链接。");
      Directory.CreateDirectory(target);
      foreach (var file in Directory.GetFiles(source)) {
        string name = Path.GetFileName(file);
        if (String.Equals(name, "household.json", StringComparison.OrdinalIgnoreCase) || name.StartsWith("household.json.", StringComparison.OrdinalIgnoreCase) || String.Equals(name, ".yingjian-server.lock", StringComparison.OrdinalIgnoreCase)) continue;
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("部署文件不能是符号链接。");
        File.Copy(file, Path.Combine(target, Path.GetFileName(file)), false);
      }
      foreach (var child in Directory.GetDirectories(source)) CopyDirectory(child, Path.Combine(target, Path.GetFileName(child)));
    }
  }

  internal sealed class MainWindow : Window {
    Process owned;
    int ownedPort;
    bool busy, probing, exiting, reallyClosing;
    Status current = new Status();
    string dataDirectory = Path.Combine(Program.Root, "data");
    readonly string settingsFile = Path.Combine(Program.Root, "launcher-settings.json");
    readonly string logFile = Path.Combine(Program.Root, "launcher-logs", "launcher-" + DateTime.Now.ToString("yyyyMMdd") + ".log");
    readonly DispatcherTimer poll = new DispatcherTimer();
    Forms.NotifyIcon tray;
    string lastExport;
    T Find<T>(string name) where T : FrameworkElement { return (T)FindName(name); }
    internal MainWindow(bool selfTest = false) {
      var source = (Window)XamlReader.Parse(Program.ReadXaml());
      Title = source.Title; Width = source.Width; Height = source.Height; MinWidth = source.MinWidth; MinHeight = source.MinHeight;
      Background = source.Background; FontFamily = source.FontFamily; FontSize = source.FontSize; WindowStartupLocation = WindowStartupLocation.CenterScreen;
      Resources = source.Resources;
      var content = source.Content; source.Content = null; Content = content;
      NameScope.SetNameScope(this, NameScope.GetNameScope(source));
      string settingsWarning = null;
      try {
        var uri = new Uri(System.Reflection.Assembly.GetExecutingAssembly().Location);
        Icon = System.Windows.Interop.Imaging.CreateBitmapSourceFromHIcon(System.Drawing.Icon.ExtractAssociatedIcon(uri.LocalPath).Handle, Int32Rect.Empty, System.Windows.Media.Imaging.BitmapSizeOptions.FromEmptyOptions());
      } catch { }
      try {
        if (File.Exists(settingsFile)) {
          var settings = Program.Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsFile));
          object port; if (settings.TryGetValue("port", out port)) Find<TextBox>("PortInput").Text = LauncherCore.ValidPort(Convert.ToString(port)).ToString();
          object savedData;
          if (settings.TryGetValue("dataDirectory", out savedData) && !String.IsNullOrWhiteSpace(Convert.ToString(savedData))) {
            try { dataDirectory = LauncherCore.ValidateDataDirectory(Convert.ToString(savedData)); }
            catch (Exception) { settingsWarning = "保存的数据目录不适合存放家庭数据，已恢复默认 data 目录。请重新选择。"; }
          }
        }
      } catch { }
      Find<TextBlock>("DataPath").Text = dataDirectory;
      Find<Button>("LocalTab").Click += (s, e) => ShowTab(false);
      Find<Button>("NasTab").Click += (s, e) => ShowTab(true);
      Find<Button>("StartButton").Click += async (s, e) => await Start();
      Find<Button>("StopButton").Click += async (s, e) => await Stop(false);
      Find<Button>("RestartButton").Click += async (s, e) => { if (await Stop(false)) await Start(); };
      Find<Button>("AdminButton").Click += (s, e) => Open("http://127.0.0.1:" + GetPort() + "/?view=server");
      Find<Button>("CopyButton").Click += (s, e) => { try { Clipboard.SetText(Find<TextBox>("AddressText").Text); Notice("局域网地址已复制，可填写到手机或电视端。"); } catch (Exception ex) { Notice(ex.Message); } };
      Find<Button>("DataButton").Click += (s, e) => { try { Directory.CreateDirectory(dataDirectory); Open(dataDirectory); } catch (Exception ex) { Notice(ex.Message); } };
      Find<Button>("ChangeDataButton").Click += (s, e) => ChangeDataDirectory();
      Find<Button>("LogButton").Click += (s, e) => ShowLogs();
      Find<Button>("CloseLogButton").Click += (s, e) => Find<Border>("LogPanel").Visibility = Visibility.Collapsed;
      Find<Button>("ExitButton").Click += async (s, e) => await Exit();
      Find<Button>("ExportButton").Click += async (s, e) => await Export();
      Find<Button>("ExportFolderButton").Click += (s, e) => { if (lastExport != null) Open(lastExport); };
      if (LauncherCore.HasOfflineImage()) {
        Find<TextBlock>("NasMode").Text = "离线镜像部署";
        Find<TextBlock>("NasHelp").Text = "已附带镜像文件。导出前校验完整性及容器验收记录，随后上传 NAS 导入并启动。";
        Find<TextBlock>("NasContents").Text = "导出完整应用镜像、Compose 和配置。NAS 不需要构建。管理密码保存在包内 .env，请妥善保存。";
        Find<Button>("ExportButton").Content = "校验并导出离线包";
      }
      Find<TextBox>("PortInput").LostKeyboardFocus += async (s, e) => { await Refresh(); };
      Find<TextBox>("PortInput").TextChanged += (s, e) => {
        if (!busy) {
          current = new Status();
          Find<TextBlock>("StateLabel").Text = "等待检查端口";
          Find<TextBox>("AddressText").Text = "服务启动后显示局域网地址";
          Controls();
        }
      };
      if (settingsWarning != null) Notice(settingsWarning);
      if (selfTest) return;
      Closing += (s, e) => { if (!reallyClosing) { e.Cancel = true; Hide(); tray.ShowBalloonTip(2500, "映间服务端", owned != null ? "服务继续运行。点击托盘图标可打开；退出请使用“退出启动器”。" : "启动器已收至托盘。点击图标可再次打开。", Forms.ToolTipIcon.Info); } };
      StateChanged += (s, e) => { if (WindowState == WindowState.Minimized) Hide(); };
      InitTray();
      poll.Interval = TimeSpan.FromSeconds(4);
      poll.Tick += async (s, e) => await Refresh();
      Loaded += async (s, e) => { await Refresh(); poll.Start(); };
    }
    int GetPort() { return LauncherCore.ValidPort(Find<TextBox>("PortInput").Text.Trim()); }
    void InitTray() {
      tray = new Forms.NotifyIcon { Text = "映间服务端", Visible = true };
      try { tray.Icon = System.Drawing.Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetExecutingAssembly().Location); }
      catch { tray.Icon = System.Drawing.SystemIcons.Application; }
      var menu = new Forms.ContextMenuStrip();
      menu.Items.Add("打开映间服务端", null, (s, e) => Restore());
      menu.Items.Add("查看日志", null, (s, e) => { Restore(); ShowLogs(); });
      menu.Items.Add("退出启动器", null, async (s, e) => await Exit());
      tray.ContextMenuStrip = menu; tray.DoubleClick += (s, e) => Restore();
    }
    void Restore() { Show(); WindowState = WindowState.Normal; Activate(); }
    internal void ShowTab(bool nas) {
      Find<Grid>("LocalPanel").Visibility = nas ? Visibility.Collapsed : Visibility.Visible;
      Find<Grid>("NasPanel").Visibility = nas ? Visibility.Visible : Visibility.Collapsed;
      Find<Button>("LocalTab").Background = Brush(nas ? "#FFFFFF" : "#B9F3E4");
      Find<Button>("NasTab").Background = Brush(nas ? "#B9F3E4" : "#FFFFFF");
      Find<TextBlock>("PageTitle").Text = nas ? "部署到 NAS" : "家里的影音服务";
      Find<TextBlock>("PageSubtitle").Text = nas ? (LauncherCore.HasOfflineImage() ? "配置连接地址，校验并导出 NAS 离线镜像包。" : "当前附带源码部署包，NAS 首次启动需要联网构建。") : "在这台电脑上运行，供局域网内的设备连接。";
      Notice("");
    }
    static SolidColorBrush Brush(string hex) { return (SolidColorBrush)new BrushConverter().ConvertFromString(hex); }
    void Notice(string message) { Find<TextBlock>("Notice").Text = message; }
    void Log(string raw) {
      string text = LauncherCore.CleanLog(raw);
      if (String.IsNullOrWhiteSpace(text)) return;
      Dispatcher.BeginInvoke(new Action(() => {
        var line = DateTime.Now.ToString("HH:mm:ss") + "  " + text + Environment.NewLine;
        var logs = Find<TextBox>("Logs"); logs.AppendText(line); if (logs.Text.Length > 50000) logs.Text = logs.Text.Substring(logs.Text.Length - 40000); logs.ScrollToEnd();
        try { Directory.CreateDirectory(Path.GetDirectoryName(logFile)); File.AppendAllText(logFile, line, Encoding.UTF8); } catch { }
      }));
    }
    void ShowLogs() { Find<Border>("LogPanel").Visibility = Visibility.Visible; Find<TextBox>("Logs").ScrollToEnd(); }
    void Open(string path) { try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); } catch (Exception ex) { Notice(ex.Message); } }
    void Controls() {
      bool running = owned != null && !owned.HasExited;
      Find<Button>("StartButton").IsEnabled = !busy && !running && !current.Reachable;
      Find<Button>("StopButton").IsEnabled = !busy && running;
      Find<Button>("RestartButton").IsEnabled = !busy && running;
      Find<TextBox>("PortInput").IsEnabled = !busy && !running;
      Find<Button>("AdminButton").IsEnabled = !busy && current.IsYingjian;
      Find<Button>("CopyButton").IsEnabled = !busy && current.IsYingjian && current.Addresses.Length > 0;
      Find<Button>("ExportButton").IsEnabled = !busy;
      Find<Button>("ChangeDataButton").IsEnabled = !busy && !running;
    }
    void SaveSettings() {
      File.WriteAllText(settingsFile, Program.Json.Serialize(new { port = GetPort(), dataDirectory = dataDirectory }), Encoding.UTF8);
    }
    void ChangeDataDirectory() {
      if (busy || owned != null && !owned.HasExited) return;
      try {
        GetPort();
        using (var dialog = new Forms.FolderBrowserDialog {
          Description = "选择数据文件夹。升级时请选择原先包含 household.json 的 data 文件夹；首次部署可选择空文件夹。",
          SelectedPath = Directory.Exists(dataDirectory) ? dataDirectory : Program.Root,
          ShowNewFolderButton = true
        }) {
          if (dialog.ShowDialog() != Forms.DialogResult.OK) return;
          string previous = dataDirectory;
          dataDirectory = LauncherCore.ValidateDataDirectory(dialog.SelectedPath);
          try { SaveSettings(); } catch { dataDirectory = previous; throw; }
          Find<TextBlock>("DataPath").Text = dataDirectory;
          Notice(File.Exists(Path.Combine(dataDirectory, "household.json")) ? "已选择原有家庭数据，下一次启动会沿用其中的片源和记录。" : "已选择数据目录，下一次启动会在这里保存片源和记录。");
        }
      } catch (Exception ex) { Notice(ex.Message); }
    }
    async Task Refresh() {
      if (probing || busy) return;
      int port;
      try { port = GetPort(); } catch (Exception ex) { Notice(ex.Message); return; }
      probing = true;
      try {
        var status = await LauncherCore.Probe(port);
        if (busy) return;
        if (Find<TextBox>("PortInput").Text.Trim() != port.ToString()) return;
        current = status;
        bool running = owned != null && !owned.HasExited;
        if (owned != null && owned.HasExited) { Log("本次启动的服务已退出，退出码 " + owned.ExitCode + "。"); owned.Dispose(); owned = null; }
        Find<TextBlock>("StateLabel").Text = status.IsYingjian ? (running ? "运行中" : "外部启动的服务") : status.Reachable || LauncherCore.PortOccupied(port) ? "端口已被占用" : running ? "正在启动" : "尚未启动";
        Find<TextBlock>("StateDetail").Text = status.IsYingjian ? (running ? "手机、电视和电脑现在可以连接。" : "可打开管理页。请在原启动窗口停止这个服务。") : status.Reachable || LauncherCore.PortOccupied(port) ? "这个端口不是可用的映间服务，请更换端口。" : "点击启动服务，然后让设备连接下方地址。";
        Find<Border>("StateDot").Background = Brush(status.IsYingjian ? "#20C894" : "#A4AEB5");
        Find<TextBlock>("VersionText").Text = status.IsYingjian ? "服务版本  " + status.Version + "  ·  " + status.Sources + " 个已启用片源" : "局域网模式 · 数据保存在本机";
        Find<TextBox>("AddressText").Text = status.Addresses.Length > 0 ? status.Addresses[0] : "服务启动后显示局域网地址";
        Find<TextBlock>("AddressHelp").Text = status.IsYingjian && status.Addresses.Length == 0 ? "没有检测到可用的局域网 IPv4，请检查网络连接。" : "手机扫码或输入链接，电视输入地址和连接码。";
        Controls();
      } finally { probing = false; }
    }
    async Task Start() {
      if (busy || owned != null && !owned.HasExited) return;
      busy = true; Controls(); Notice("正在启动服务…");
      try {
        int port = GetPort();
        var existing = await LauncherCore.Probe(port);
        if (existing.Reachable || LauncherCore.PortOccupied(port)) throw new Exception(existing.IsYingjian ? "该端口的映间服务已在其他窗口运行，可以直接打开管理页。" : "端口已经被占用，请修改端口后启动。");
        ownedPort = port;
        owned = await LauncherCore.StartHost(port, dataDirectory, Log);
        bool ready = false;
        for (int i = 0; i < 45; i++) {
          if (owned.HasExited) throw new Exception("服务启动失败，请打开日志查看原因。");
          var status = await LauncherCore.Probe(port);
          if (status.IsYingjian) { ready = true; break; }
          await Task.Delay(300);
        }
        if (!ready) throw new Exception("服务还没有就绪，请查看日志。可以点击停止后重新启动。");
        SaveSettings();
        Notice("服务已启动。进入管理页添加片源、生成连接码。");
        Log("已启动本机服务，端口 " + port + "。");
      } catch (Exception ex) { Notice(ex.Message); Log(ex.Message); }
      finally { busy = false; }
      await Refresh(); Controls();
    }
    async Task<bool> Stop(bool fromExit) {
      if (busy && !fromExit) return false;
      if (owned == null || owned.HasExited) return true;
      busy = true; Controls(); Notice("正在保存数据并停止服务…");
      bool stopped = false;
      var stoppingProcess = owned;
      try {
        if (!await LauncherCore.StopHost(stoppingProcess)) { Notice("服务仍在保存或关闭，请查看日志后再试。启动器没有强制终止进程。"); }
        else {
          int exitCode = stoppingProcess.ExitCode;
          if (Object.ReferenceEquals(owned, stoppingProcess)) owned = null;
          stoppingProcess.Dispose();
          if (exitCode != 0) throw new Exception("服务已退出，但保存或关闭过程出现错误，请查看日志。退出码：" + exitCode);
          Notice("服务已停止，数据已保留。"); Log("服务已正常停止。");
          stopped = true;
        }
      } catch (Exception ex) { Notice(ex.Message); Log(ex.Message); }
      finally { busy = false; }
      await Refresh(); Controls();
      return stopped;
    }
    async Task Exit() {
      if (exiting || busy) return;
      if (owned != null && !owned.HasExited && MessageBox.Show(this, "退出将停止本次启动的服务，正在连接的设备会断开。确定退出吗？", "退出映间服务端", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
      exiting = true;
      if (!await Stop(true)) { exiting = false; return; }
      reallyClosing = true; poll.Stop(); tray.Visible = false; tray.Dispose(); Close(); Application.Current.Shutdown();
    }
    async Task Export() {
      string ip = Find<TextBox>("NasIp").Text.Trim(), password = Find<PasswordBox>("NasPassword").Password;
      string volume = Find<TextBox>("NasVolume").Text.Trim(); if (volume.Length == 0) volume = "yingjian-data";
      int port;
      try { port = LauncherCore.ValidPort(Find<TextBox>("NasPort").Text.Trim()); LauncherCore.BuildEnv(ip, port, password, volume); }
      catch (Exception ex) { Notice(ex.Message); return; }
      using (var dialog = new Forms.FolderBrowserDialog { Description = "选择保存位置，将新建独立的 NAS 部署文件夹和 ZIP 包。", ShowNewFolderButton = true }) {
        if (dialog.ShowDialog() != Forms.DialogResult.OK) return;
        busy = true; Controls(); Notice(LauncherCore.HasOfflineImage() ? "正在校验并导出完整镜像，文件较大，请稍候…" : "正在导出源码部署包…");
        try {
          lastExport = await Task.Run(() => LauncherCore.ExportNas(dialog.SelectedPath, ip, port, password, volume));
          Find<PasswordBox>("NasPassword").Clear();
          Find<Button>("ExportFolderButton").Visibility = Visibility.Visible;
          Notice(LauncherCore.HasOfflineImage() ? "离线包已生成。上传 NAS，导入 image.tar，再按 README 启动 Compose。" : "源码包已生成。NAS 仍需联网下载依赖和构建；这不是离线镜像包。");
          Log("NAS 部署包已导出。");
        } catch (Exception ex) { Notice("导出失败：" + ex.Message); }
        finally { busy = false; Controls(); }
      }
    }
  }
}
