using System.Runtime.InteropServices;

namespace AudioXtractor;

// Owns OLE dragging on an STA thread. The physical press began in Chromium,
// so its original button-down message is not in this thread's input queue.
internal sealed class DragSurface(Action<object> report) : Control
{
    System.Windows.Forms.Timer? armTimer;
    bool dragging;
    static int PrimaryButton => SystemInformation.MouseButtonsSwapped ? 0x02 : 0x01;
    static bool Pressed(int key) => (GetAsyncKeyState(key) & 0x8000) != 0;

    public void Arm(string[] files, IntPtr owner, string operationId)
    {
        report(new { @event = "drag-armed", operationId, count = files.Length, buttonDown = Pressed(PrimaryButton), ownerValid = IsWindow(owner) });
        if (dragging) { report(new { @event = "drag-complete", operationId, status = "cancelled" }); return; }
        armTimer?.Dispose(); armTimer = null;
        if (!Pressed(PrimaryButton) || !IsWindow(owner)) { report(new { @event = "drag-complete", operationId, status = "cancelled", reason = "The mouse was released before Windows received the drag." }); return; }
        GetCursorPos(out var start);
        var threshold = SystemInformation.DragSize;
        var startedAt = Environment.TickCount64;
        armTimer = new System.Windows.Forms.Timer { Interval = 10 };
        armTimer.Tick += (_, _) =>
        {
            if (!Pressed(PrimaryButton) || Pressed(0x1b) || !IsWindow(owner) || Environment.TickCount64 - startedAt > 15000)
            {
                armTimer?.Dispose(); armTimer = null;
                report(new { @event = "drag-complete", operationId, status = "cancelled", phase = "waiting-for-movement", elapsedMs = Environment.TickCount64 - startedAt, escape = Pressed(0x1b), buttonDown = Pressed(PrimaryButton) }); return;
            }
            GetCursorPos(out var current);
            if (Math.Abs(current.X - start.X) < threshold.Width / 2 && Math.Abs(current.Y - start.Y) < threshold.Height / 2) return;
            armTimer?.Dispose(); armTimer = null;
            dragging = true;
            uint ownerThread = GetWindowThreadProcessId(owner, out _), ownThread = GetCurrentThreadId();
            bool attached = false;
            try
            {
                // STAThread establishes the COM apartment, but does not initialize
                // OLE. This host has no visible WinForms window to do that for it.
                // Without OleRequired, DoDragDrop can silently return None.
                if (Application.OleRequired() != ApartmentState.STA) throw new InvalidOperationException("Windows file dragging requires the companion's STA thread.");
                // Chromium received the press and owns the foreground input
                // queue. A hidden background helper cannot capture the gesture
                // across the desktop until it joins that queue and takes capture.
                if (ownThread != ownerThread)
                {
                    attached = AttachThreadInput(ownThread, ownerThread, true);
                    if (!attached) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Windows could not attach the file drag to this browser window.");
                }
                SetCapture(Handle);
                if (GetCapture() != Handle) throw new InvalidOperationException("Windows could not capture this file drag. Keep AudioXtractor in front and try again.");
                report(new { @event = "drag-start", operationId, count = files.Length, inputAttached = attached, captureOwned = true, ownThread, ownerThread });
                var result = OleDrag.Run(files, escape => escape || Pressed(0x1b), () => Pressed(PrimaryButton));
                if (result.Result < 0) Marshal.ThrowExceptionForHR(result.Result);
                report(new { @event = "drag-complete", operationId, status = result.Effect == 1 ? "dropped" : "cancelled", effect = result.Effect, count = files.Length, queryCount = result.Queries, hresult = $"0x{result.Result:X8}" });
            }
            catch (Exception error) { report(new { @event = "drag-complete", operationId, status = "failed", error = error.Message, hresult = $"0x{error.HResult:X8}" }); }
            finally
            {
                var capture = GetCapture();
                if (capture != IntPtr.Zero && GetWindowThreadProcessId(capture, out _) == ownThread) ReleaseCapture();
                if (attached) AttachThreadInput(ownThread, ownerThread, false);
                dragging = false;
            }
        };
        armTimer.Start();
    }

    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] static extern bool AttachThreadInput(uint firstThread, uint secondThread, bool attach);
    [DllImport("user32.dll")] static extern IntPtr SetCapture(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr GetCapture();
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
}
