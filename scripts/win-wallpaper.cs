// Win11 "behind desktop icons" wallpaper helper — precompiled to
// win-wallpaper.exe so the Electron side spawns a fast native process instead
// of paying PowerShell + Add-Type (Roslyn) compile latency on every call
// (which timed out the execFileSync path).
//
// Why it exists: on Windows 11 builds like 26200 the desktop has NO separate
// WorkerW behind the icons — Progman hosts SHELLDLL_DefView (icons) AND the
// wallpaper directly, spanning the whole virtual desktop. electron-as-wallpaper
// looks for a WorkerW and fails ("couldn't locate WorkerW"). This does the
// reparent that build needs: WS_POPUP->WS_CHILD, SetParent(hwnd, Progman),
// SetWindowPos(HWND_BOTTOM) onto the window's own monitor (multi-display safe),
// so the overlay renders over the wallpaper but UNDER the icons. detach
// reverses it so the window returns to a normal top-level overlay.
//
// Usage:  win-wallpaper.exe <attach|detach|check> <hwndDecimal>
// Emits one JSON line on stdout: {"ok":bool,"parentMatch":bool,"rect":"L,T,R,B","error":"..."}
//
// Build: csc.exe /nologo /target:exe /out:win-wallpaper.exe win-wallpaper.cs
using System;
using System.Text;
using System.Runtime.InteropServices;

static class ApiaWallpaper
{
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint f);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);

    delegate bool EnumProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    const int GWL_STYLE = -16;
    const long WS_CHILD = 0x40000000L;
    const long WS_POPUP = unchecked((long)0x80000000L);
    const uint MONITOR_DEFAULTTONEAREST = 2;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40;
    static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

    static IntPtr FindProgman()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) =>
        {
            var sb = new StringBuilder(64);
            GetClassNameW(h, sb, 64);
            if (sb.ToString() == "Progman") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static string J(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }

    static int Main(string[] args)
    {
        // Per-Monitor-V2 so GetMonitorInfo / GetWindowRect report PHYSICAL
        // pixels. Once the window is reparented to Progman it inherits Progman's
        // (primary monitor's) DPI space, so SetWindowPos args are scaled by the
        // primary's factor. We therefore divide the physical target rect by
        // Progman's scale (GetDpiForWindow/96) before SetWindowPos — see attach.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }

        if (args.Length < 2) { Console.WriteLine("{\"ok\":false,\"error\":\"usage: <attach|detach> <hwnd>\"}"); return 1; }
        string action = args[0];
        IntPtr hwnd;
        try { hwnd = new IntPtr((long)ulong.Parse(args[1])); }
        catch { Console.WriteLine("{\"ok\":false,\"error\":\"bad-hwnd\"}"); return 1; }

        try
        {
            if (action == "attach")
            {
                IntPtr progman = FindProgman();
                if (progman == IntPtr.Zero) { Console.WriteLine("{\"ok\":false,\"error\":\"progman-not-found\"}"); return 1; }

                // Capture the window's monitor BEFORE reparenting (still top-level
                // at its overlay position).
                IntPtr mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                MONITORINFO mi = new MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (!GetMonitorInfo(mon, ref mi)) { Console.WriteLine("{\"ok\":false,\"error\":\"getmonitorinfo-failed\"}"); return 1; }
                RECT m = mi.rcMonitor;

                long style = GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64();
                long newStyle = (style & ~WS_POPUP) | WS_CHILD;
                SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(newStyle));
                SetParent(hwnd, progman);

                RECT pr; GetWindowRect(progman, out pr);
                // Per-Monitor-V2: both the monitor rect and Progman rect are in
                // physical pixels here, and SetWindowPos on the Progman child
                // takes the same physical coordinates. So position/size are just
                // the monitor's physical rect translated into Progman-client
                // space. (Display 2 is a 3840x2160 panel at 150% = 2560x1440
                // DIP; covering its full physical rect is what fills the monitor
                // edge-to-edge — earlier "2560x1440" only covered the left 2/3.)
                int x = m.L - pr.L, y = m.T - pr.T, w = m.R - m.L, ht = m.B - m.T;
                SetWindowPos(hwnd, HWND_BOTTOM, x, y, w, ht, SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW);

                // Z-order: Progman hosts SHELLDLL_DefView (icons) on top and a
                // WorkerW that paints the actual wallpaper UNDER the icons.
                // HWND_BOTTOM above dropped us BELOW that WorkerW → hidden behind
                // the wallpaper. Re-insert just under SHELLDLL_DefView so we sit
                // ABOVE the wallpaper WorkerW but BEHIND the icons.
                IntPtr defView = FindWindowExW(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
                // The z-order re-insert is what makes us visible (above the
                // wallpaper WorkerW). If we can't find the icons host or the
                // re-insert fails, we'd be hidden behind the wallpaper — report
                // failure so Electron falls back to a visible overlay instead of
                // claiming a "working" but invisible wallpaper. (Codex MUST-FIX)
                bool zOk = defView != IntPtr.Zero &&
                    SetWindowPos(hwnd, defView, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

                bool match = GetParent(hwnd) == progman;
                RECT r; GetWindowRect(hwnd, out r);
                // Validate the child actually lands on the monitor (parentMatch
                // alone could accept a wrong-size/position child). Allow a few px
                // of slack for rounding.
                bool sizeOk = Math.Abs((r.R - r.L) - (m.R - m.L)) <= 4 && Math.Abs((r.B - r.T) - (m.B - m.T)) <= 4;
                bool posOk = Math.Abs(r.L - m.L) <= 4 && Math.Abs(r.T - m.T) <= 4;
                bool ok = match && sizeOk && posOk && zOk;
                Console.WriteLine("{\"ok\":" + (ok ? "true" : "false") + ",\"parentMatch\":" + (match ? "true" : "false") +
                    ",\"rect\":\"" + r.L + "," + r.T + "," + r.R + "," + r.B + "\"}");
                return ok ? 0 : 1;
            }
            else if (action == "check")
            {
                // Health probe: are we still parented to Progman? Explorer
                // restarts recreate the shell windows and orphan the child.
                IntPtr progman = FindProgman();
                bool match = progman != IntPtr.Zero && GetParent(hwnd) == progman;
                Console.WriteLine("{\"ok\":true,\"parentMatch\":" + (match ? "true" : "false") + "}");
                return 0;
            }
            else if (action == "detach")
            {
                long style = GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64();
                long newStyle = (style & ~WS_CHILD) | WS_POPUP;
                SetParent(hwnd, IntPtr.Zero);
                SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(newStyle));
                SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                Console.WriteLine("{\"ok\":true}");
                return 0;
            }
            Console.WriteLine("{\"ok\":false,\"error\":\"unknown-action\"}");
            return 1;
        }
        catch (Exception e)
        {
            Console.WriteLine("{\"ok\":false,\"error\":\"" + J(e.Message) + "\"}");
            return 1;
        }
    }
}
