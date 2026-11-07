using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AudioXtractor;

internal static partial class Program
{
    static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static readonly Stream Input = Console.OpenStandardInput(), Output = Console.OpenStandardOutput();
    static readonly SemaphoreSlim OutputLock = new(1, 1), SaveLock = new(1, 1), Workers = new(2, 2);
    static readonly ConcurrentDictionary<string, Conversion> Jobs = new();
    static readonly ConcurrentDictionary<string, Upload> Uploads = new();
    static readonly ConcurrentDictionary<string, Process> Processes = new();
    static readonly ConcurrentDictionary<string, CancellationTokenSource> Cancellations = new();
    static readonly DragSurface Ui = new(ReportDrag);
    static readonly SemaphoreSlim DragLogLock = new(1, 1);
    static string Root = "", Downloader = "", Ffmpeg = "", NodeRuntime = "node";
    static bool Ready;
    static bool WindowClient;
    static IntPtr ParentWindow;
    const long MaxFileBytes = 2L * 1024 * 1024 * 1024;

    [STAThread]
    static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        _ = Ui.Handle;
        if (args.Contains("--drag-self-test"))
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(OleDrag.Probe())); return;
        }
        if (args.Contains("--self-test")) { SelfTest(); return; }
        if (args.Length == 3 && args[0] == "--drop-target") { DropTarget(ValidId(args[1]), args[2]); return; }
        // Chrome verifies allowed_origins. Also reject arbitrary non-extension callers.
        if (args.Length == 0 || !Regex.IsMatch(args[0], "^chrome-extension://[a-p]{32}/$")) return;
        var parentArgument = args.FirstOrDefault(argument => argument.StartsWith("--parent-window=", StringComparison.Ordinal));
        if (long.TryParse(parentArgument?.Split('=')[1], out var parentHandle)) ParentWindow = new IntPtr(parentHandle);
        var configPath = Path.Combine(AppContext.BaseDirectory, "tools.json");
        if (File.Exists(configPath))
        {
            var config = JsonNode.Parse(File.ReadAllText(configPath));
            Downloader = config?["ytDlp"]?.GetValue<string>() ?? "";
            Ffmpeg = config?["ffmpeg"]?.GetValue<string>() ?? "";
            NodeRuntime = config?["node"]?.GetValue<string>() ?? "node";
        }
        Task.Run(ReadMessages);
        Application.Run();
    }

    static void ReportDrag(object data)
    {
        _ = Send(data);
        var root = Root;
        if (string.IsNullOrEmpty(root)) return;
        var entry = JsonSerializer.SerializeToNode(data)!.AsObject();
        entry["version"] = "2.3.0"; entry["at"] = DateTimeOffset.UtcNow.ToString("O");
        _ = SaveDrag();
        async Task SaveDrag()
        {
            await DragLogLock.WaitAsync();
            try { await File.WriteAllTextAsync(Path.Combine(root, "last-drag.json"), entry.ToJsonString()); }
            catch { /* Diagnostics must not interrupt file dragging. */ }
            finally { DragLogLock.Release(); }
        }
    }

    static async Task ReadMessages()
    {
        try
        {
            var header = new byte[4];
            while (true)
            {
                if (!await ReadExact(header)) break;
                int length = BitConverter.ToInt32(header);
                if (length < 2 || length > 1024 * 1024) break;
                var body = new byte[length];
                if (!await ReadExact(body)) break;
                var message = JsonNode.Parse(body)?.AsObject();
                if (message != null) _ = Dispatch(message);
            }
        }
        catch { /* Browser disconnected or sent an invalid frame. */ }
        finally
        {
            foreach (var process in Processes.Values) try { process.Kill(true); } catch { }
            foreach (var upload in Uploads.Values) await upload.Stream.DisposeAsync();
            Ui.BeginInvoke(() => Application.ExitThread());
        }
    }

    static async Task<bool> ReadExact(byte[] data)
    {
        int total = 0;
        while (total < data.Length) { int size = await Input.ReadAsync(data.AsMemory(total)); if (size == 0) return false; total += size; }
        return true;
    }

    static async Task Send(object data)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(data, JsonOptions);
        if (bytes.Length > 900000) throw new InvalidOperationException("Response is too large.");
        await OutputLock.WaitAsync();
        try { await Output.WriteAsync(BitConverter.GetBytes(bytes.Length)); await Output.WriteAsync(bytes); await Output.FlushAsync(); }
        finally { OutputLock.Release(); }
    }

    static string Text(JsonObject message, string key) => message[key]?.GetValue<string>() ?? "";
    static string ValidId(string value) => Guid.TryParseExact(value, "D", out _) ? value : throw new ArgumentException("Invalid file ID.");
    static string CachePath(string id) => Path.Combine(Root, "files", ValidId(id));
    static string SafeName(string value)
    {
        var name = Regex.Replace(value, "[<>:\"/\\\\|?*\\x00-\\x1f]", "-").Trim(' ', '.');
        if (name.Length > 170) name = name[..170];
        if (name.Length == 0 || Regex.IsMatch(name, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)", RegexOptions.IgnoreCase)) name = "audio.wav";
        return name;
    }
    static string Url(string value, bool youtube = false)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https") || !string.IsNullOrEmpty(uri.UserInfo) || value.Length > 16384) throw new ArgumentException("Enter a valid website URL.");
        var host = uri.IdnHost.ToLowerInvariant();
        if (youtube && host != "youtu.be" && host != "youtube.com" && !host.EndsWith(".youtube.com")) throw new ArgumentException("Use a YouTube video link.");
        return uri.AbsoluteUri;
    }
    static string GetFile(string id)
    {
        id = ValidId(id);
        if (Jobs.TryGetValue(id, out var job) && job.Status == "completed" && File.Exists(job.File)) return CheckedPath(job.File);
        var metadata = Path.Combine(CachePath(id), "file.json");
        if (!File.Exists(metadata))
        {
            // Window hosts are read-only clients of the service's catalog.
            // A conversion can complete after this window connected.
            var catalog = Path.Combine(Root, "jobs.json");
            if (File.Exists(catalog))
            {
                using var input = new FileStream(catalog, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var saved = JsonSerializer.Deserialize<List<Conversion>>(input, JsonOptions)?.FirstOrDefault(job => job.Id == id && job.Status == "completed");
                if (saved != null && File.Exists(saved.File)) return CheckedPath(saved.File);
            }
            throw new FileNotFoundException("The audio is still preparing for drag-out. Try again in a moment.");
        }
        var path = JsonNode.Parse(File.ReadAllText(metadata))?["path"]?.GetValue<string>() ?? "";
        if (!File.Exists(path)) throw new FileNotFoundException("Local audio file is missing.");
        return CheckedPath(path);
    }
    static string CheckedPath(string path)
    {
        var full = Path.GetFullPath(path);
        if (!full.StartsWith(Path.GetFullPath(Root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("File is outside AudioXtractor's library.");
        return full;
    }
    static string[] Ids(JsonObject message) => (message["ids"]?.AsArray() ?? []).Select(node => ValidId(node?.GetValue<string>() ?? "")).Distinct().Take(200).ToArray();

    static async Task Dispatch(JsonObject message)
    {
        var id = Text(message, "id");
        try
        {
            var result = await Handle(message);
            result["id"] = id; result["ok"] = true;
            await Send(result);
        }
        catch (Exception error) { await Send(new { id, ok = false, error = error.Message }); }
    }

    static async Task<JsonObject> Handle(JsonObject message)
    {
        var command = Text(message, "command");
        if (command == "HELLO")
        {
            var client = ValidId(Text(message, "clientId"));
            if (Ready && Path.GetFileName(Root) != client) throw new ArgumentException("Client cannot change during a connection.");
            Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AudioXtractor", "clients", client);
            Directory.CreateDirectory(Path.Combine(Root, "files"));
            Directory.CreateDirectory(Path.Combine(Root, "conversions"));
            if (!Ready) WindowClient = Text(message, "role") == "window";
            if (!Ready && !WindowClient)
            {
                var saved = Path.Combine(Root, "jobs.json");
                if (File.Exists(saved)) foreach (var job in JsonSerializer.Deserialize<List<Conversion>>(File.ReadAllText(saved), JsonOptions) ?? [])
                {
                    if (job.Status is "queued" or "working") { job.Status = "failed"; job.Error = "Conversion was interrupted. Retry this link."; }
                    Jobs[job.Id] = job;
                }
            }
            Ready = true;
            return new() { ["version"] = "2.3.0", ["ytDlp"] = File.Exists(Downloader), ["ffmpeg"] = File.Exists(Ffmpeg), ["nativeDrag"] = true, ["windowHandle"] = ParentWindow.ToInt64().ToString(), ["role"] = WindowClient ? "window" : "service" };
        }
        if (!Ready) throw new InvalidOperationException("Connect to AudioXtractor first.");
        if (WindowClient && command is not ("PIN" or "PIN_STATE" or "ARM_DRAG" or "DRAG" or "DRAG_INFO" or "DRAG_STATE" or "FILE_STATUS")) throw new InvalidOperationException("Use the audio service connection for this action.");
        switch (command)
        {
            case "DRAG_STATE": return new() { ["last"] = File.Exists(Path.Combine(Root, "last-drag.json")) ? JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(Root, "last-drag.json"))) : null };
            case "PIN":
            {
                bool pin = message["pinned"]?.GetValue<bool>() ?? false;
                var handle = OwnWindow(message);
                if (!SetWindowPos(handle, pin ? new IntPtr(-1) : new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)) throw new InvalidOperationException("Windows could not update this window.");
                return new() { ["pinned"] = IsTopmost(handle), ["handle"] = handle.ToInt64() };
            }
            case "PIN_STATE":
            {
                var handle = OwnWindow(message);
                return new() { ["found"] = handle != IntPtr.Zero, ["pinned"] = IsTopmost(handle), ["handle"] = handle.ToInt64().ToString() };
            }
            case "FILE_STATUS":
                try { var file = GetFile(Text(message, "fileId")); return new() { ["ready"] = true, ["size"] = new FileInfo(file).Length, ["filename"] = Path.GetFileName(file) }; }
                catch (FileNotFoundException) { return new() { ["ready"] = false }; }
            case "FILE_BEGIN":
            {
                var fileId = ValidId(Text(message, "fileId"));
                long size = message["size"]?.GetValue<long>() ?? -1;
                if (size < 0 || size > MaxFileBytes + 56) throw new ArgumentException("Audio is too large.");
                if (Uploads.TryRemove(fileId, out var old)) await old.Stream.DisposeAsync();
                var directory = CachePath(fileId); Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, SafeName(Text(message, "filename")));
                var stream = new FileStream(path + ".partial", FileMode.Create, FileAccess.Write, FileShare.None, 65536, true);
                Uploads[fileId] = new(stream, path, size);
                return new();
            }
            case "FILE_CHUNK":
            {
                var fileId = ValidId(Text(message, "fileId"));
                if (!Uploads.TryGetValue(fileId, out var upload)) throw new InvalidOperationException("Audio transfer expired.");
                var bytes = Convert.FromBase64String(Text(message, "data"));
                if (bytes.Length > 256 * 1024 || upload.Stream.Position + bytes.Length > upload.Size || message["offset"]?.GetValue<long>() != upload.Stream.Position) throw new ArgumentException("Invalid audio chunk.");
                await upload.Stream.WriteAsync(bytes);
                return new() { ["offset"] = upload.Stream.Position };
            }
            case "FILE_END":
            {
                var fileId = ValidId(Text(message, "fileId"));
                if (!Uploads.TryRemove(fileId, out var upload)) throw new InvalidOperationException("Audio transfer expired.");
                if (upload.Stream.Position != upload.Size) { await upload.Stream.DisposeAsync(); throw new InvalidOperationException("Audio transfer is incomplete."); }
                await upload.Stream.DisposeAsync(); File.Move(upload.Path + ".partial", upload.Path, true);
                await File.WriteAllTextAsync(Path.Combine(CachePath(fileId), "file.json"), JsonSerializer.Serialize(new { path = upload.Path }));
                return new() { ["ready"] = true };
            }
            case "DRAG_INFO":
            {
                var paths = Ids(message).Select(GetFile).ToArray();
                if (paths.Length == 0) throw new ArgumentException("Select audio to drag.");
                return new() { ["files"] = JsonSerializer.SerializeToNode(paths), ["formats"] = JsonSerializer.SerializeToNode(new[] { DataFormats.FileDrop }) };
            }
            case "ARM_DRAG":
            case "DRAG":
            {
                var handle = OwnWindow(message);
                var paths = Ids(message).Select(GetFile).ToArray();
                if (paths.Length == 0) throw new ArgumentException("Select audio to drag.");
                var operationId = Guid.NewGuid().ToString();
                Ui.BeginInvoke(() => Ui.Arm(paths, handle, operationId));
                return new() { ["armed"] = true, ["operationId"] = operationId };
            }
            case "EXPORT":
            {
                var paths = Ids(message).Select(GetFile).ToArray();
                var directory = Path.Combine(DownloadsFolder(), "AudioXtractor"); Directory.CreateDirectory(directory);
                var exported = new List<string>();
                foreach (var source in paths)
                {
                    var destination = UniqueDestination(directory, Path.GetFileName(source));
                    File.Copy(source, destination, false); exported.Add(destination);
                }
                return new() { ["count"] = exported.Count, ["directory"] = directory };
            }
            case "READ_FILE":
            {
                var path = GetFile(Text(message, "fileId"));
                long offset = message["offset"]?.GetValue<long>() ?? 0;
                using var file = File.OpenRead(path);
                if (offset < 0 || offset > file.Length) throw new ArgumentException("Invalid offset.");
                file.Position = offset; var buffer = new byte[(int)Math.Min(192 * 1024, file.Length - offset)];
                int total = 0; while (total < buffer.Length) total += await file.ReadAsync(buffer.AsMemory(total));
                return new() { ["data"] = Convert.ToBase64String(buffer), ["size"] = file.Length, ["filename"] = Path.GetFileName(path) };
            }
            case "FILE_DELETE":
            {
                var fileId = ValidId(Text(message, "fileId"));
                var directory = CachePath(fileId);
                if (Directory.Exists(directory)) Directory.Delete(directory, true);
                return new();
            }
            case "RESOLVE": return await Resolve(Url(Text(message, "url")));
            case "QUEUE":
            {
                var urls = message["urls"]?.AsArray() ?? [];
                if (urls.Count == 0 || urls.Count > 50) throw new ArgumentException("Add 1 to 50 links at a time.");
                bool original = Text(message, "mode") == "original";
                var format = Text(message, "format");
                if (original && !Regex.IsMatch(format, "^[a-zA-Z0-9_.+-]{1,80}$")) throw new ArgumentException("Invalid audio format.");
                var validated = urls.Select(node => Url(node?.GetValue<string>() ?? "", !original)).Distinct().ToArray();
                foreach (var url in validated)
                {
                    var job = new Conversion { Id = Guid.NewGuid().ToString(), Url = url, Title = original ? "Original audio" : "YouTube audio", CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Mode = original ? "original" : "mp3", Format = format };
                    Jobs[job.Id] = job; _ = RunJob(job);
                }
                await SaveJobs(); return new() { ["count"] = validated.Length };
            }
            case "LIST_JOBS": return new() { ["jobs"] = JsonSerializer.SerializeToNode(Jobs.Values.OrderByDescending(job => job.CreatedAt).Take(300), JsonOptions) };
            case "CANCEL":
            {
                var jobId = ValidId(Text(message, "jobId"));
                if (Cancellations.TryGetValue(jobId, out var cancellation)) cancellation.Cancel();
                if (Processes.TryGetValue(jobId, out var process)) try { process.Kill(true); } catch { }
                if (Jobs.TryGetValue(jobId, out var job) && job.Status is "queued" or "working") { job.Status = "cancelled"; await SaveJobs(); }
                return new();
            }
            case "DELETE_JOB":
            {
                var jobId = ValidId(Text(message, "jobId"));
                if (Jobs.TryGetValue(jobId, out var existing) && existing.Status is "queued" or "working") throw new InvalidOperationException("Cancel the conversion first.");
                Jobs.TryRemove(jobId, out _);
                var directory = Path.Combine(Root, "conversions", jobId);
                if (Directory.Exists(directory)) Directory.Delete(directory, true);
                await SaveJobs(); return new();
            }
            default: throw new ArgumentException("Unknown companion action.");
        }
    }

    static void NeedTools()
    {
        if (!File.Exists(Downloader) || !File.Exists(Ffmpeg)) throw new InvalidOperationException("The companion needs yt-dlp and FFmpeg. Run the companion setup script to configure installed tools.");
    }
    static ProcessStartInfo StartInfo(IEnumerable<string> args)
    {
        NeedTools();
        var info = new ProcessStartInfo(Downloader) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        foreach (var arg in new[] { "--ignore-config", "--no-playlist", "--no-cache-dir", "--no-warnings", "--socket-timeout", "15", "--retries", "1", "--ffmpeg-location", Path.GetDirectoryName(Ffmpeg)!, "--js-runtimes", "node:" + NodeRuntime }.Concat(args)) info.ArgumentList.Add(arg);
        return info;
    }
    static async Task<JsonObject> Resolve(string url)
    {
        using var process = new Process { StartInfo = StartInfo(["--skip-download", "--dump-single-json", "--", url]) };
        process.Start();
        process.StandardInput.Close();
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync(new CancellationTokenSource(TimeSpan.FromSeconds(90)).Token); }
        catch { try { process.Kill(true); } catch { } throw new InvalidOperationException("This page took too long to resolve."); }
        if (process.ExitCode != 0) throw new InvalidOperationException(CleanError(await error));
        var document = JsonNode.Parse(await output)?.AsObject() ?? throw new InvalidOperationException("No media found.");
        var title = document["title"]?.GetValue<string>() ?? "Page audio";
        var results = new JsonArray();
        var items = new List<JsonObject>();
        void Collect(JsonObject item, int depth = 0)
        {
            if (depth > 3 || items.Count >= 50) return;
            if (item["entries"] is JsonArray entries) { foreach (var child in entries.OfType<JsonObject>()) Collect(child, depth + 1); }
            else items.Add(item);
        }
        Collect(document);
        foreach (var item in items)
        {
            var formats = item["formats"]?.AsArray() ?? new JsonArray(item.DeepClone());
            foreach (var format in formats.Where(node => node?["vcodec"]?.GetValue<string>() == "none" && node?["acodec"]?.GetValue<string>() != "none" && node?["has_drm"]?.GetValue<bool>() != true).OrderByDescending(node => node?["abr"]?.GetValue<double>() ?? 0).Take(12))
            {
                string mediaUrl = format?["url"]?.GetValue<string>() ?? "";
                if (!Uri.TryCreate(mediaUrl, UriKind.Absolute, out var parsed) || parsed.Scheme is not ("http" or "https")) continue;
                results.Add(new JsonObject { ["url"] = mediaUrl, ["pageUrl"] = document["entries"] != null ? mediaUrl : url, ["formatId"] = format?["format_id"]?.DeepClone() ?? JsonValue.Create("bestaudio"), ["format"] = (format?["ext"]?.GetValue<string>() ?? "audio").ToUpperInvariant(), ["bitrate"] = format?["abr"]?.DeepClone(), ["sampleRate"] = format?["asr"]?.DeepClone(), ["size"] = (format?["filesize"] ?? format?["filesize_approx"])?.DeepClone(), ["protocol"] = format?["protocol"]?.DeepClone(), ["title"] = item["title"]?.GetValue<string>() ?? title });
            }
        }
        if (results.Count == 0) throw new InvalidOperationException("No separate audio stream was exposed by this page. Detected page sources and recording are still available.");
        return new() { ["sources"] = results, ["title"] = title };
    }

    static async Task RunJob(Conversion job)
    {
        var cancellation = new CancellationTokenSource(); Cancellations[job.Id] = cancellation;
        bool acquired = false;
        try
        {
            await Workers.WaitAsync(cancellation.Token); acquired = true;
            if (job.Status == "cancelled") return;
            job.Status = "working"; job.Stage = "Finding audio"; await SaveJobs();
            var directory = Path.Combine(Root, "conversions", job.Id); Directory.CreateDirectory(directory);
            for (int attempt = 0; attempt < 2; attempt++)
            {
            job.File = "";
            var args = new List<string> { "--newline", "--progress", "--progress-template", "download:AXPROGRESS:%(progress._percent_str)s", "--print", "before_dl:AXTITLE:%(title)s", "--print", "after_move:AXFILE:%(filepath)s", "--no-simulate", "--windows-filenames", "--trim-filenames", "150", "--max-filesize", "512M", "--extract-audio", "--audio-format", job.Mode == "mp3" ? "mp3" : "best", "--audio-quality", "320K", "--format", job.Mode == "original" ? job.Format : "bestaudio/best", "--output", Path.Combine(directory, "%(title).100B [%(id)s].%(ext)s"), "--", job.Url };
            using var process = new Process { StartInfo = StartInfo(args) };
            Processes[job.Id] = process; process.Start(); process.StandardInput.Close();
            var errors = new StringBuilder();
            async Task ReadLines(StreamReader reader, bool stderr)
            {
                while (await reader.ReadLineAsync() is { } line)
                {
                    if (line.StartsWith("AXTITLE:")) job.Title = line[8..];
                    else if (line.StartsWith("AXFILE:")) job.File = CheckedPath(line[7..]);
                    else if (line.StartsWith("AXPROGRESS:")) { job.Stage = "Downloading"; if (double.TryParse(line[11..].Trim().TrimEnd('%'), System.Globalization.CultureInfo.InvariantCulture, out var progress)) job.Progress = Math.Clamp(progress, 0, 100); }
                    else if (line.Contains("[ExtractAudio]") || line.Contains("[ffmpeg]")) job.Stage = job.Mode == "mp3" ? "Converting to MP3" : "Saving original audio";
                    if (stderr && errors.Length < 16000) errors.AppendLine(line);
                }
            }
            await Task.WhenAll(ReadLines(process.StandardOutput, false), ReadLines(process.StandardError, true), process.WaitForExitAsync(cancellation.Token));
            if (process.ExitCode != 0 || !File.Exists(job.File))
            {
                if (attempt == 0 && errors.ToString().Contains("403", StringComparison.Ordinal))
                {
                    job.Stage = "Refreshing expired audio link"; job.Progress = 0;
                    Processes.TryRemove(job.Id, out _);
                    await Task.Delay(350, cancellation.Token); continue;
                }
                throw new InvalidOperationException(CleanError(errors.ToString()));
            }
            job.Bytes = new FileInfo(job.File).Length; job.Filename = Path.GetFileName(job.File); job.Status = "completed"; job.Progress = 100; job.Stage = "Ready to drag or download";
            if (job.Mode == "original") { var destination = Path.Combine(DownloadsFolder(), "AudioXtractor"); Directory.CreateDirectory(destination); File.Copy(job.File, UniqueDestination(destination, job.Filename), false); }
            break;
            }
        }
        catch (OperationCanceledException) { job.Status = "cancelled"; job.Stage = "Cancelled"; }
        catch (Exception error) { if (job.Status != "cancelled") { job.Status = "failed"; job.Error = error.Message; job.Stage = "Could not convert"; } }
        finally
        {
            if (Processes.TryRemove(job.Id, out var process)) try { if (!process.HasExited) process.Kill(true); } catch { }
            Cancellations.TryRemove(job.Id, out _); cancellation.Dispose();
            if (acquired) Workers.Release();
            await SaveJobs();
        }
    }

    static async Task SaveJobs()
    {
        await SaveLock.WaitAsync();
        try { var path = Path.Combine(Root, "jobs.json"); await File.WriteAllTextAsync(path + ".tmp", JsonSerializer.Serialize(Jobs.Values.OrderByDescending(job => job.CreatedAt).ToArray(), JsonOptions)); File.Move(path + ".tmp", path, true); }
        finally { SaveLock.Release(); }
    }
    static string CleanError(string error)
    {
        var lines = error.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var message = lines.LastOrDefault(line => line.Contains("ERROR:")) ?? lines.LastOrDefault() ?? "No downloadable audio was returned.";
        return message.Trim().Length > 700 ? message.Trim()[..700] : message.Trim();
    }
    static string UniqueDestination(string directory, string filename)
    {
        var path = Path.Combine(directory, SafeName(filename));
        for (int i = 1; File.Exists(path); i++) path = Path.Combine(directory, $"{Path.GetFileNameWithoutExtension(filename)} ({i}){Path.GetExtension(filename)}");
        return path;
    }
    static string DownloadsFolder()
    {
        var id = new Guid("374DE290-123F-4565-9164-39C4925E467B");
        if (SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out var pointer) == 0) { try { return Marshal.PtrToStringUni(pointer)!; } finally { Marshal.FreeCoTaskMem(pointer); } }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
    }

    static IntPtr FindPanel(string token)
    {
        IntPtr found = IntPtr.Zero;
        string marker = "AudioXtractor" + string.Concat(token.Replace("-", "").Select(character => Convert.ToString(Convert.ToInt32(character.ToString(), 16), 2).PadLeft(4, '0').Replace('0', '\u200b').Replace('1', '\u200c')));
        EnumWindows((handle, _) =>
        {
            var title = new StringBuilder(1024); GetWindowText(handle, title, title.Capacity);
            if (!title.ToString().Contains(marker, StringComparison.Ordinal)) return true;
            GetWindowThreadProcessId(handle, out var pid);
            try { if (IsBrowser(Process.GetProcessById((int)pid).ProcessName)) { found = handle; return false; } } catch { }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    static bool IsTopmost(IntPtr handle) => (GetWindowLongPtr(handle, -20).ToInt64() & 0x8) != 0;
    static bool IsBrowser(string processName) => processName is "chrome" or "msedge" or "chromium" or "brave" or "opera" or "vivaldi";
    static IntPtr OwnWindow(JsonObject message)
    {
        var handle = ParentWindow;
        if (handle != IntPtr.Zero) handle = GetAncestor(handle, 2);
        else if (!WindowClient) handle = FindPanel(ValidId(Text(message, "token")));
        if (handle == IntPtr.Zero || !IsWindow(handle)) throw new InvalidOperationException("Reconnect this AudioXtractor window to its desktop companion.");
        GetWindowThreadProcessId(handle, out var processId);
        if (!IsBrowser(Process.GetProcessById((int)processId).ProcessName)) throw new InvalidOperationException("The window does not belong to the browser.");
        return handle;
    }
    static void DropTarget(string token, string output)
    {
        var parent = FindPanel(token);
        if (parent == IntPtr.Zero) return;
        using var form = new Form { Text = "AudioXtractor drag verification", AllowDrop = true, ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.FixedSingle, StartPosition = FormStartPosition.Manual, BackColor = System.Drawing.Color.FromArgb(48, 48, 60), ForeColor = System.Drawing.Color.White, Size = new System.Drawing.Size(220, 180) };
        var label = new Label { Text = "WINDOWS FILE DROP TEST\n\nDrag an AudioXtractor row here", Dock = DockStyle.Fill, TextAlign = System.Drawing.ContentAlignment.MiddleCenter };
        form.Controls.Add(label);
        form.DragEnter += (_, args) => { if (args.Data?.GetDataPresent(DataFormats.FileDrop) == true) args.Effect = DragDropEffects.Copy; };
        form.DragDrop += (_, args) =>
        {
            if (args.Data?.GetData(DataFormats.FileDrop) is not string[] files) return;
            File.WriteAllText(output, JsonSerializer.Serialize(new { files, format = DataFormats.FileDrop }));
            label.Text = $"Accepted {files.Length} real audio file(s)"; form.BackColor = System.Drawing.Color.FromArgb(42, 77, 60);
        };
        form.Shown += (_, _) => { SetParent(form.Handle, parent); form.Location = new System.Drawing.Point(255, 720); };
        Application.Run(form);
    }
    static void SelfTest()
    {
        using var form = new Form { Text = "AudioXtractor native self-test", ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new System.Drawing.Point(-32000, -32000) };
        form.Show(); Application.DoEvents();
        var handle = form.Handle;
        SetWindowPos(handle, new IntPtr(-1), 0, 0, 0, 0, 0x1 | 0x2 | 0x10);
        bool topmost = IsTopmost(handle);
        SetWindowPos(handle, new IntPtr(-2), 0, 0, 0, 0, 0x1 | 0x2 | 0x10);
        var files = new[] { Path.Combine(Path.GetTempPath(), "test-a.wav"), Path.Combine(Path.GetTempPath(), "test-b.mp3") };
        var data = new DataObject(DataFormats.FileDrop, files);
        bool drop = data.GetDataPresent(DataFormats.FileDrop) && ((string[])data.GetData(DataFormats.FileDrop)!).SequenceEqual(files);
        bool urls = false; try { Url("file:///secret", true); } catch (ArgumentException) { urls = true; }
        var result = JsonSerializer.Serialize(new { topmost, unpinned = !IsTopmost(handle), nativeFileDrop = drop, rejectsUnsafeUrls = urls });
        Console.Out.WriteLine(result); Environment.ExitCode = topmost && !IsTopmost(handle) && drop && urls ? 0 : 1;
    }

    record Upload(FileStream Stream, string Path, long Size);
    class Conversion
    {
        public string Id { get; set; } = "";
        public string Url { get; set; } = "";
        public string Title { get; set; } = "";
        public long CreatedAt { get; set; }
        public string Status { get; set; } = "queued";
        public string Stage { get; set; } = "Queued";
        public double Progress { get; set; }
        public string Mode { get; set; } = "mp3";
        public string Format { get; set; } = "";
        public string File { get; set; } = "";
        public string Filename { get; set; } = "";
        public long Bytes { get; set; }
        public string Error { get; set; } = "";
    }
    delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
    [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
}
