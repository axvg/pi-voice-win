# e2e/hold-space.ps1: launches pi in its own console, injects a held Space (press + auto-repeat)
# with WriteConsoleInput (no focus stealing), speaks a phrase via SAPI so the mic hears something,
# then prints the PI_VOICE_LOG. Run: pwsh -File e2e/hold-space.ps1
param([int]$HoldSec = 4, [string]$Phrase = "hola, esto es una prueba de dictado en español", [int]$WarmSec = 15)
$log = "$env:TEMP\pi-voice-e2e.log"; Remove-Item $log -ErrorAction SilentlyContinue
$repo = Split-Path $PSScriptRoot -Parent
$p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c set PI_VOICE_LOG=$log&& cd /d `"$repo`" && pi --no-session --extension ./index.ts --model gpt-4.1" -PassThru
Add-Type -Namespace W -Name C -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string n, uint a, uint sh, IntPtr sa, uint cd, uint fl, IntPtr t);
public static IntPtr Conin() { return CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); }
[StructLayout(LayoutKind.Sequential)] public struct KEY { public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode; public ushort wVirtualScanCode; public char UnicodeChar; public uint dwControlKeyState; }
[StructLayout(LayoutKind.Sequential)] public struct REC { public ushort EventType; public ushort pad; public KEY Key; }
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteConsoleInput(IntPtr h, REC[] r, uint n, out uint written);
public static void Space(bool down) {
  var r = new REC[1]; r[0].EventType = 1; r[0].Key.bKeyDown = down ? 1 : 0; r[0].Key.wRepeatCount = 1;
  r[0].Key.wVirtualKeyCode = 0x20; r[0].Key.wVirtualScanCode = 0x39; r[0].Key.UnicodeChar = ' ';
  uint w; WriteConsoleInput(Conin(), r, 1, out w);
}
"@
Start-Sleep $WarmSec
[W.C]::FreeConsole() | Out-Null
$ok = [W.C]::AttachConsole([uint32]$p.Id); $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
Add-Content $log "driver attach ok=$ok err=$err"
if (-not $ok) { Stop-Process $p; Get-Content $log; exit 1 }
$tts = New-Object -ComObject SAPI.SpVoice; $tts.Volume = 100
[W.C]::Space($true)
Start-Sleep -Milliseconds 500                           # OS initial repeat delay
$tts.Speak($Phrase, 1)                                  # async
$end = (Get-Date).AddSeconds($HoldSec)
while ((Get-Date) -lt $end) { [W.C]::Space($true); Start-Sleep -Milliseconds 33 }   # auto-repeat
[W.C]::Space($false)
Start-Sleep 8
[W.C]::FreeConsole() | Out-Null
Stop-Process $p -ErrorAction SilentlyContinue; Get-Process pi -ErrorAction SilentlyContinue | Stop-Process
Get-Content $log
