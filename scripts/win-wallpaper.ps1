# Win11 "behind desktop icons" wallpaper helper for a single HWND.
#
# Why this exists: on Windows 11 (e.g. build 26200) the desktop has no separate
# WorkerW behind the icons — `Progman` hosts SHELLDLL_DefView (icons) AND the
# wallpaper directly, spanning the whole virtual desktop. `electron-as-wallpaper`
# looks for a WorkerW and fails ("couldn't locate WorkerW"). This helper does the
# reparent the way that build actually needs:
#   1. WS_POPUP -> WS_CHILD on the target window
#   2. SetParent(hwnd, Progman)
#   3. SetWindowPos(HWND_BOTTOM) onto the window's own monitor, in Progman-client
#      coords, so it renders over the wallpaper but UNDER the icons.
# detach reverses it (SetParent NULL, restore WS_POPUP) so the window goes back
# to a normal top-level overlay.
#
# Invoked by electron/services/wallpaperMode.js as a last-resort fallback. Emits
# one JSON line on stdout: {"ok":bool,"parentMatch":bool,"rect":"L,T,R,B","error":...}
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('attach', 'detach')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Hwnd
)

$ErrorActionPreference = 'Stop'

$signature = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ApiaWp {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindowLongPtrW(IntPtr h, int i);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetWindowLongPtrW(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  public const int GWL_STYLE = -16;
  public const long WS_CHILD = 0x40000000L;
  public const long WS_POPUP = unchecked((long)0x80000000L);
  public static IntPtr FindProgman() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var sb = new StringBuilder(64); GetClassNameW(h, sb, 64);
      if (sb.ToString() == "Progman") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Add-Type -TypeDefinition $signature -Language CSharp | Out-Null

# Same DPI awareness for every rect we read/write, or monitor vs Progman coords
# would be in different spaces (Codex MUST-FIX).
try { [ApiaWp]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { try { [ApiaWp]::SetProcessDPIAware() | Out-Null } catch {} }

function Emit($obj) { $obj | ConvertTo-Json -Compress }

try {
  $h = [IntPtr][int64]([uint64]::Parse($Hwnd))
  $GWL = [ApiaWp]::GWL_STYLE
  $HWND_BOTTOM = [IntPtr]1
  $SWP_FRAMECHANGED = 0x20; $SWP_NOACTIVATE = 0x10; $SWP_SHOWWINDOW = 0x40
  $SWP_NOMOVE = 0x2; $SWP_NOSIZE = 0x1; $SWP_NOZORDER = 0x4

  if ($Action -eq 'attach') {
    $progman = [ApiaWp]::FindProgman()
    if ($progman -eq [IntPtr]::Zero) { Emit(@{ ok = $false; error = 'progman-not-found' }); exit 1 }

    # Monitor the window currently sits on — captured BEFORE reparenting, while
    # it is still a top-level window at its overlay position.
    $MONITOR_DEFAULTTONEAREST = 2
    $mon = [ApiaWp]::MonitorFromWindow($h, $MONITOR_DEFAULTTONEAREST)
    $mi = New-Object ApiaWp+MONITORINFO; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    [ApiaWp]::GetMonitorInfo($mon, [ref]$mi) | Out-Null
    $m = $mi.rcMonitor

    $style = [ApiaWp]::GetWindowLongPtrW($h, $GWL).ToInt64()
    $newStyle = ($style -band (-bnot [ApiaWp]::WS_POPUP)) -bor [ApiaWp]::WS_CHILD
    [ApiaWp]::SetWindowLongPtrW($h, $GWL, [IntPtr]$newStyle) | Out-Null
    [ApiaWp]::SetParent($h, $progman) | Out-Null

    $pr = New-Object ApiaWp+RECT; [ApiaWp]::GetWindowRect($progman, [ref]$pr) | Out-Null
    $x = $m.L - $pr.L; $y = $m.T - $pr.T; $w = $m.R - $m.L; $ht = $m.B - $m.T
    $flags = $SWP_FRAMECHANGED -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW
    [ApiaWp]::SetWindowPos($h, $HWND_BOTTOM, $x, $y, $w, $ht, $flags) | Out-Null

    $gp = [ApiaWp]::GetParent($h)
    $r = New-Object ApiaWp+RECT; [ApiaWp]::GetWindowRect($h, [ref]$r) | Out-Null
    Emit(@{ ok = $true; parentMatch = ($gp -eq $progman); rect = "$($r.L),$($r.T),$($r.R),$($r.B)" })
  }
  else {
    # detach: child -> top-level overlay again. The app re-asserts bounds.
    $style = [ApiaWp]::GetWindowLongPtrW($h, $GWL).ToInt64()
    $newStyle = ($style -band (-bnot [ApiaWp]::WS_CHILD)) -bor [ApiaWp]::WS_POPUP
    [ApiaWp]::SetParent($h, [IntPtr]::Zero) | Out-Null
    [ApiaWp]::SetWindowLongPtrW($h, $GWL, [IntPtr]$newStyle) | Out-Null
    $flags = $SWP_FRAMECHANGED -bor $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE
    [ApiaWp]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, $flags) | Out-Null
    Emit(@{ ok = $true })
  }
}
catch {
  Emit(@{ ok = $false; error = $_.Exception.Message })
  exit 1
}
