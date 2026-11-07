# AudioXtractor privacy

AudioXtractor 2.3 processes audio on your device. It has no conversion backend, analytics, advertising, accounts or remote UI scripts. It never requests microphone access.

It observes media URLs, response types/sizes, media titles and playback state on HTTP/HTTPS pages. Tab sources live in Chrome's session storage and clear on navigation or tab closure. URLs may contain temporary tokens, used only for local discovery and downloads you initiate.

Opening Recorder connects the current website's audio and shows a live waveform. Before Start and after Stop, no recording file is written; only transient waveform/peak data is sent to the local panel. Start begins saving uncompressed audio. The same tab capture and playback monitor remain connected between takes. Disconnect tab, leaving Recorder while idle, or closing the idle panel releases capture. Active recording continues with the panel closed. No microphone or video is captured. WAV files and metadata (title, hostname, creation time, duration, audio format) stay in the extension's private local filesystem. Stop before closing the browser.

Source downloads contact the original host through Chrome's download manager, with existing browser cookies. Saved-recording downloads read only the local WAV. No information is sent to an AudioXtractor service because there is no such service.

Delete removes a local recording after confirmation. Downloaded copies remain in your filesystem. Uninstalling or clearing extension storage removes its library. Export anything you want to keep.

The Windows companion communicates only through Chrome native messaging and has no listening network service. It stores drag-ready audio and conversion files under `%LOCALAPPDATA%\AudioXtractor\clients\`. Each browser installation uses a separate random client ID. Recording deletion also removes its prepared companion copy; deleting a conversion removes its companion file. Downloaded copies remain. Companion files survive uninstalling the browser extension.

The companion keeps one local `last-drag.json` diagnostic per client. It contains the last gesture's operation ID, time, companion version, button/drag phase, file count, result and Windows error code. It contains no audio data or audio filenames and is overwritten by the next gesture. It is not uploaded.

Page resolution and conversion contact the original media website through installed yt-dlp and FFmpeg. Browser cookies are not exported to the companion. Pinning changes only AudioXtractor's own native window. Window size, position and pin preference remain in extension-local storage.

Permissions: website access/webRequest discover media; scripting/activeTab scan the selected page; tabCapture connects the selected website after extension invocation; offscreen runs the engine; storage keeps session metadata; downloads exports files.
