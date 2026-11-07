# AudioXtractor working notes

- Browser tests must be silent by default. Do not play reference tones or preview audio without an explicit user request. `npm run test:browser` uses muted Chromium and never starts playback. The capture suite is separately gated by `AUDIOXTRACTOR_AUDIBLE_TESTS=1`.
- Use CodeGraph for structural exploration. The local `codegraph node/explore/sync` CLI works if the MCP request stalls.
- The runtime extension is in `extension/`; rebuild `dist/AudioXtractor` before testing or deployment. Preserve its path so the unpacked extension ID and existing browser recordings remain stable.
- The Windows companion uses existing .NET, yt-dlp, FFmpeg and Node. Do not update or install third-party packages without the user's approval.
- Native file paths must stay inside the companion client library. Keep browser-to-native actions restricted to trusted extension pages.
