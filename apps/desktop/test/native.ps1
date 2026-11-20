# 윈도 네이티브 확인 도구(시험 전용): 앞 창, 좌표 아래 창, 실제 마우스 클릭·키 입력, UI Automation 트리.
# 좌표는 물리 픽셀(이 프로세스를 DPI 인식으로 둔다).
param([string]$Command, [string]$A = '', [string]$B = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static IntPtr Find(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => { if (IsWindowVisible(h) && Title(h).Contains(part)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
}
"@
[void][Native]::SetThreadDpiAwarenessContext([IntPtr](-4))

function Describe([IntPtr]$h) {
  $procId = 0
  [void][Native]::GetWindowThreadProcessId($h, [ref]$procId)
  [pscustomobject]@{ hwnd = [int64]$h; title = [Native]::Title($h); pid = $procId } | ConvertTo-Json -Compress
}

$keys = @{ ctrl = 0x11; shift = 0x10; enter = 0x0D; tab = 0x09; escape = 0x1B; k = 0x4B; x = 0x58 }

switch ($Command) {
  'fg' { Describe ([Native]::GetForegroundWindow()) }
  'activate' {
    if (-not $A) { throw 'Expected a test window title' }
    $target = [Native]::Find($A)
    if ($target -eq [IntPtr]::Zero) { throw "Missing test window '$A'" }
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.AppActivate([Native]::Title($target))
  }
  'find' {
    $h = [Native]::Find($A)
    $r = New-Object Native+RECT
    [void][Native]::GetWindowRect($h, [ref]$r)
    [pscustomobject]@{ hwnd = [int64]$h; left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom } | ConvertTo-Json -Compress
  }
  'at' {
    $p = New-Object Native+POINT
    $p.X = [int]$A; $p.Y = [int]$B
    Describe ([Native]::GetAncestor([Native]::WindowFromPoint($p), 2))
  }
  'click' {
    [void][Native]::SetCursorPos([int]$A, [int]$B)
    Start-Sleep -Milliseconds 80
    [Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    'clicked'
  }
  'keys' {
    # 앞 창이 시험 창($B)이 아니면 보내지 않는다(사용자가 쓰던 프로그램에 키가 들어가지 않게)
    $front = [Native]::Title([Native]::GetForegroundWindow())
    if (-not $B -or -not $front.Contains($B)) { throw "refusing keys: foreground is '$front'" }
    $combo = $A.Split('+') | ForEach-Object { [byte]$keys[$_] }
    foreach ($k in $combo) { [Native]::keybd_event($k, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 20 }
    [array]::Reverse($combo)
    foreach ($k in $combo) { [Native]::keybd_event($k, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 20 }
    'sent'
  }
  'uia' {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $AE = [System.Windows.Automation.AutomationElement]
    $win = $AE::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,
      (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $A)))
    if (-not $win) { '[]'; break }
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $rows = foreach ($e in $all) {
      $c = $e.Current
      [pscustomobject]@{ type = $c.ControlType.ProgrammaticName; localized = $c.LocalizedControlType; id = $c.AutomationId; name = $c.Name; focusable = $c.IsKeyboardFocusable; enabled = $c.IsEnabled; offscreen = $c.IsOffscreen; focused = $c.HasKeyboardFocus }
    }
    @($rows) | ConvertTo-Json -Compress
  }
  'focused' {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $f = [System.Windows.Automation.AutomationElement]::FocusedElement
    [pscustomobject]@{ type = $f.Current.ControlType.ProgrammaticName; name = $f.Current.Name } | ConvertTo-Json -Compress
  }
}
