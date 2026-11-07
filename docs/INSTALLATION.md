# Install AudioXtractor

## Browser extension

1. Open the [latest release](https://github.com/jordanw0204-rgb/AudioXtractor/releases/latest) and download **AudioXtractor-2.3.0.zip** under **Assets**.
2. Extract the ZIP into a permanent folder. It contains `manifest.json` at its top level.
3. Open `chrome://extensions`, `brave://extensions`, or `edge://extensions`.
4. Enable **Developer mode**, click **Load unpacked**, and select that extracted folder.
5. Visit a normal website and click AudioXtractor's toolbar icon to open its panel.

You can now download discovered source files and record tab audio as WAV. Browser internal pages and the extensions page cannot be recorded. After loading the extension, refresh an already-open website if its media does not appear.

This is the [standard Chrome unpacked-extension workflow](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked). Keep the extracted folder; the browser reads the extension from that location.

## Windows companion

The companion adds native dragging into Desktop or audio apps, always-on-top pinning, original-stream resolution, and YouTube-to-MP3 conversion. It is optional for source downloads and WAV recording. It currently supports Windows only.

### Requirements

Install these through their official instructions, if they are not already available:

| Requirement | Official download / instructions |
| --- | --- |
| .NET 9 **Desktop Runtime**, Windows x64 | [Microsoft .NET 9 downloads](https://dotnet.microsoft.com/en-us/download/dotnet/9.0) — choose Desktop Runtime, not just the ASP.NET runtime |
| Node.js 22 or newer | [Node.js downloads](https://nodejs.org/en/download) |
| Current yt-dlp | [yt-dlp installation](https://github.com/yt-dlp/yt-dlp#installation) |
| FFmpeg | [FFmpeg downloads](https://ffmpeg.org/download.html) |

`node`, `yt-dlp`, and `ffmpeg` must be available on your Windows `PATH` before running the installer. Open a new PowerShell window after installing tools. The companion ZIP does not bundle or install third-party tools.

### Setup

1. Download **AudioXtractor-Companion-2.3.0.zip** from the same release.
2. Extract it to a permanent folder, separate from the extension folder. Keep all its files together.
3. On your browser's extensions page, copy AudioXtractor's **ID**. Developer mode displays it on the extension card.
4. Open PowerShell in the extracted companion folder and run this, replacing `YOUR_EXTENSION_ID` with the copied ID:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Companion.ps1 -ExtensionId YOUR_EXTENSION_ID
   ```

5. Close and reopen the AudioXtractor panel. Its footer should say **Local companion connected**.

No administrator access is needed. The installer writes configuration beside the companion and registers its native messaging host for the current Windows user in Chrome, Chromium, Edge, and Brave. The execution-policy option applies only to this PowerShell invocation. The companion folder must remain in place after installation. Installing for another browser profile or a different unpacked ID requires running the command with that ID too.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Companion is unavailable | Confirm .NET 9 Desktop Runtime is installed, rerun the installer with the ID shown in this browser, then reopen the panel. Keep its extracted folder in place. |
| Installer cannot find a command | In a new PowerShell window, run `node --version`, `yt-dlp --version`, and `ffmpeg -version`. Add missing tools to `PATH` using their official setup instructions. |
| Drag does nothing | Wait until the recording finishes preparing. Hold its name and drag to Desktop or an app that accepts files. Both apps should run at the same privilege level. Select multiple rows to drag them together. |
| YouTube conversion fails | Confirm yt-dlp is current and Node/FFmpeg are available. Sign-in requirements, unavailable videos, and website changes can prevent conversion. AudioXtractor does not export browser cookies to the companion. |
| Recording permission error | Open a regular website and click the AudioXtractor toolbar icon on that tab before opening Recorder. |
| Brief playback interruption | The browser can change the audio route when a tab first connects. Open Recorder before playback when practical. Further takes reuse that input. |

## Updates and your library

Stop and save any active recording. Export recordings you want to keep as a backup. Close the panel, extract the new extension ZIP over the **same extension folder**, then click **Reload** on the extensions page. Reopen the panel and check the footer version.

Do not remove and re-add the extension to upgrade it. Keeping its folder path preserves the unpacked ID. Uninstalling the extension or clearing its storage removes the browser recording library.

For a companion update, close the panel, extract the new companion ZIP to its permanent folder, rerun `Install-Companion.ps1` with your extension ID, then reopen the panel. Downloaded files and companion library copies remain on disk; see [Privacy](PRIVACY.md) for storage details.
