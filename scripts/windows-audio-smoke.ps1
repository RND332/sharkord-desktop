<#
.SYNOPSIS Smoke-tests native\out\win-audio-capture.exe process-tree isolation on a real Windows playback device.
.DESCRIPTION Builds a throwaway fixture (three visible root windows whose child processes loop 997/1493/2137 Hz tones), runs the real helper per scenario and checks the spectral amplitude of each tone in the captured float32 PCM: positive control, screen-exclude isolation, window-include isolation, READY while the shared app is silent with its tone resuming in the same helper run, and fail-closed refusals (including malformed CLI arguments in -CheckOnly mode). Exits nonzero on a leak, a missing tone, an unavailable playback device or a lifecycle failure.
.PARAMETER HelperPath The win-audio-capture.exe to test; defaults to native\out\win-audio-capture.exe of this repository.
.PARAMETER CheckOnly Compiles the embedded C# and the fixture and runs the malformed-CLI refusals only (the helper must be built; no window, tone or audio activation happens); audio is explicitly not tested.
.EXAMPLE powershell -NoProfile -File scripts\windows-audio-smoke.ps1
#>
[CmdletBinding()]
param([string]$HelperPath, [switch]$CheckOnly)

if ($env:OS -ne 'Windows_NT') { Write-Host 'windows audio smoke: this script runs on Windows only' -ForegroundColor Red; exit 2 }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Rate = 48000; $script:Channels = 2; $script:FrameBytes = 8
$script:ReadyTimeoutMs = 15000; $script:RunMs = 3000
$script:AudibleFloor = 0.01; $script:PresentRatio = 0.3; $script:AbsentRatio = 0.01
$script:ToneFrequencies = @(997.0, 1493.0, 2137.0)
$script:ToneLabels = @{ 997.0 = 'simulated Sharkord'; 1493.0 = 'shared window app'; 2137.0 = 'unrelated app' }
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Runs = New-Object System.Collections.Generic.List[object]
$script:Fixtures = New-Object System.Collections.Generic.List[object]
$script:HelperExe = ''; $script:FixtureExe = ''; $script:TempDir = ''; $script:Scratch = $null
$script:ReferenceAmplitude = 0.0; $script:PresentThreshold = 0.0; $script:AbsentThreshold = 0.0
$script:ExitCode = 0

$analysisSource = @'
namespace SharkordAudioSmoke
{
    using System;
    public static class Tone
    {
        public static double Amplitude(byte[] pcm, int channels, int rate, double frequency, int channel, int maxFrames)
        {
            int frameBytes = channels * 4;
            int available = pcm.Length / frameBytes;
            int frames = maxFrames > 0 && available > maxFrames ? maxFrames : available;
            if (frames < 64) return 0.0;
            double coefficient = 2.0 * Math.Cos(2.0 * Math.PI * frequency / rate), first = 0.0, second = 0.0;
            int offset = (available - frames) * frameBytes + channel * 4;
            for (int i = 0; i < frames; i++)
            {
                double current = BitConverter.ToSingle(pcm, offset + i * frameBytes) + coefficient * first - second;
                second = first; first = current;
            }
            double power = first * first + second * second - coefficient * first * second;
            return 2.0 * Math.Sqrt(power < 0.0 ? 0.0 : power) / frames;
        }
    }
}
'@

$fixtureSource = @'
using System; using System.Diagnostics; using System.Drawing; using System.Globalization; using System.IO; using System.Media; using System.Threading; using System.Windows.Forms;
internal static class Fixture
{
    [STAThread]
    private static int Main(string[] args)
    {
        string tone = Value(args, "--play-tone");
        return tone != null ? PlayTone(args, tone) : Host(args);
    }
    private static int Host(string[] args)
    {
        string role = Text(args, "--role", "fixture");
        string gate = Value(args, "--gate-file");
        Form form = new Form();
        form.Text = "sharkord audio smoke " + role;
        form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(40, 40); form.ClientSize = new Size(220, 60); form.Show();
        Console.WriteLine("PID=" + Process.GetCurrentProcess().Id);
        Console.WriteLine("HWND=" + (((ulong)form.Handle.ToInt64()) & 0xFFFFFFFFUL));
        ProcessStartInfo start = new ProcessStartInfo(Application.ExecutablePath);
        start.UseShellExecute = false; start.CreateNoWindow = true; start.RedirectStandardError = true;
        start.Arguments = "--play-tone " + Text(args, "--tone", "997");
        if (!string.IsNullOrEmpty(gate)) start.Arguments += " --gate-file \"" + gate + "\"";
        Process child = Process.Start(start);
        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Console.Error.WriteLine("[tone] " + e.Data); };
        child.BeginErrorReadLine();
        Console.WriteLine("CHILD=" + child.Id);
        Console.Out.Flush();
        Application.Run(form);
        try { if (!child.HasExited) child.Kill(); } catch { }
        return 0;
    }
    private static int PlayTone(string[] args, string toneText)
    {
        string gate = Value(args, "--gate-file");
        double limit = Number(Value(args, "--seconds"), 600.0);
        double frequency = Number(toneText, 997.0);
        Stopwatch clock = Stopwatch.StartNew();
        while (!string.IsNullOrEmpty(gate) && !File.Exists(gate) && clock.Elapsed.TotalSeconds < limit) Thread.Sleep(50);
        SoundPlayer player = new SoundPlayer(BuildWav(frequency));
        try { player.PlayLooping(); }
        catch (Exception error) { Console.Error.WriteLine("cannot play the tone: " + error.Message); return 1; }
        while (clock.Elapsed.TotalSeconds < limit) Thread.Sleep(100);
        return 0;
    }
    private static Stream BuildWav(double frequency)
    {
        int rate = 48000, channels = 2, frames = rate, dataBytes = frames * channels * 2;
        MemoryStream stream = new MemoryStream(44 + dataBytes);
        BinaryWriter writer = new BinaryWriter(stream);
        writer.Write(new char[] { 'R', 'I', 'F', 'F' }); writer.Write(36 + dataBytes);
        writer.Write(new char[] { 'W', 'A', 'V', 'E' }); writer.Write(new char[] { 'f', 'm', 't', ' ' }); writer.Write(16);
        writer.Write((short)1); writer.Write((short)channels); writer.Write(rate); writer.Write(rate * channels * 2);
        writer.Write((short)(channels * 2)); writer.Write((short)16);
        writer.Write(new char[] { 'd', 'a', 't', 'a' }); writer.Write(dataBytes);
        for (int i = 0; i < frames; i++) { short value = (short)(12000 * Math.Sin(2.0 * Math.PI * frequency * i / rate)); writer.Write(value); writer.Write(value); }
        writer.Flush(); stream.Position = 0;
        return stream;
    }
    private static string Value(string[] args, string name)
    {
        for (int i = 0; i + 1 < args.Length; i++) { if (string.Equals(args[i], name, StringComparison.Ordinal)) return args[i + 1]; }
        return null;
    }
    private static string Text(string[] args, string name, string fallback)
    {
        string value = Value(args, name);
        return value == null ? fallback : value;
    }
    private static double Number(string text, double fallback)
    {
        double value = 0;
        return !string.IsNullOrEmpty(text) && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value) ? value : fallback;
    }
}
'@

function Num { param([double]$Value, [string]$Format = 'F4') [string]::Format([Globalization.CultureInfo]::InvariantCulture, ('{0:' + $Format + '}'), $Value) }
function Write-Scenario { param([string]$Text) Write-Host ''; Write-Host ('=== ' + $Text + ' ===') -ForegroundColor Cyan }
function Write-Pass { param([string]$Text) Write-Host ('    PASS ' + $Text) -ForegroundColor Green }
function Write-Fail { param([string]$Text) Write-Host ('    FAIL ' + $Text) -ForegroundColor Red; $script:Failures.Add($Text) }
function Resolve-HelperPath {
  param([string]$Override)
  if ($Override) { return [IO.Path]::GetFullPath($Override) }
  return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\native\out\win-audio-capture.exe'))
}
function New-ProcessStartInfo {
  param([string]$FileName, [string[]]$Arguments)
  $quoted = @(); foreach ($argument in $Arguments) { if ($argument -match '\s') { $quoted += ('"' + $argument + '"') } else { $quoted += $argument } }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $FileName; $info.Arguments = ($quoted -join ' '); $info.UseShellExecute = $false
  $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  return $info
}
function Compile-Fixture {
  param([string]$Source, [string]$ExePath)
  Add-Type -TypeDefinition $Source -Language CSharp -OutputAssembly $ExePath -OutputType ConsoleApplication -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll') -ErrorAction Stop
}
function New-ScratchWindow {
  param([switch]$Destroy)
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'sharkord audio smoke scratch window'; $form.ShowInTaskbar = $false; $form.Show()
  $handle = [string]([int64]$form.Handle.ToInt64() -band 0xFFFFFFFFL)
  if ($Destroy) { $form.Close() }
  return [pscustomobject]@{ Handle = $handle; Form = $form }
}
function Start-Fixture {
  param([string]$Role, [double]$Tone, [string]$GateFile = '')
  $arguments = @('--role', $Role, '--tone', (Num -Value $Tone -Format 'F0'))
  if ($GateFile) { $arguments += @('--gate-file', $GateFile) }
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = New-ProcessStartInfo -FileName $script:FixtureExe -Arguments $arguments
  if (-not $process.Start()) { throw ('cannot start the fixture root for ' + $Role) }
  $entry = [pscustomobject]@{ Role = $Role; Process = $process; FixturePid = [int64]0; Hwnd = [int64]0; ChildPid = [int64]0; Lines = New-Object System.Collections.Generic.List[string]; Pending = $process.StandardError.ReadLineAsync() }
  $script:Fixtures.Add($entry)
  foreach ($key in @('PID', 'HWND', 'CHILD')) {
    $task = $process.StandardOutput.ReadLineAsync()
    if (-not $task.Wait(20000)) { throw ('the fixture root for ' + $Role + ' did not report ' + $key) }
    $line = $task.Result
    if ($line -notmatch ('^' + $key + '=(\d+)$')) { throw ('the fixture root for ' + $Role + ' did not report ' + $key + ' (got ' + $line + ')') }
    if ($key -eq 'PID') { $entry.FixturePid = [int64]$Matches[1] } elseif ($key -eq 'HWND') { $entry.Hwnd = [int64]$Matches[1] } else { $entry.ChildPid = [int64]$Matches[1] }
  }
  try { $null = [System.Diagnostics.Process]::GetProcessById($entry.ChildPid) } catch { throw ('the tone child of ' + $Role + ' died immediately') }
  return $entry
}
function Show-FixtureStderr {
  foreach ($fixture in $script:Fixtures) {
    try { while ($fixture.Pending.Wait(50)) { $line = $fixture.Pending.Result; if ($null -eq $line) { break }; $fixture.Lines.Add($line); $fixture.Pending = $fixture.Process.StandardError.ReadLineAsync() } } catch { }
    if ($fixture.Lines.Count -gt 0) { Write-Host ('    fixture ' + $fixture.Role + ' stderr: ' + ($fixture.Lines -join ' | ')) -ForegroundColor Yellow }
  }
}
function Start-Helper {
  param([string[]]$HelperArguments)
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = New-ProcessStartInfo -FileName $script:HelperExe -Arguments $HelperArguments
  if (-not $process.Start()) { throw ('cannot start the helper: ' + $script:HelperExe) }
  $output = New-Object System.IO.MemoryStream
  $run = [pscustomobject]@{ Process = $process; Output = $output; Copy = $process.StandardOutput.BaseStream.CopyToAsync($output); Pending = $process.StandardError.ReadLineAsync(); Lines = New-Object System.Collections.Generic.List[string]; Bytes = $null; ReadyPid = $null; ExitCode = $null; Exited = $false; Copied = $false; Stopped = $false }
  Write-Host ('    run: ' + (Split-Path -Leaf $script:HelperExe) + ' ' + ($HelperArguments -join ' '))
  $script:Runs.Add($run)
  return $run
}
function Stop-Helper {
  param($Run)
  if ($null -eq $Run -or $Run.Stopped) { return $true }
  $Run.Stopped = $true
  try { if (-not $Run.Process.HasExited) { $Run.Process.Kill() } } catch { }
  try { $Run.Exited = $Run.Process.WaitForExit(5000) } catch { }
  try { $Run.ExitCode = $Run.Process.ExitCode } catch { }
  try { $Run.Copied = $Run.Copy.Wait(5000) -and $Run.Copy.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion } catch { }
  try { while ($Run.Pending.Wait(500)) { $line = $Run.Pending.Result; if ($null -eq $line) { break }; $Run.Lines.Add($line); $Run.Pending = $Run.Process.StandardError.ReadLineAsync() } } catch { }
  try { $Run.Process.Dispose() } catch { }
  return ($Run.Exited -and $Run.Copied)
}
function Get-StderrText {
  param($Run)
  if ($Run.Lines.Count -eq 0) { return '(no stderr)' }
  return ($Run.Lines -join ' | ')
}
function Wait-Ready {
  param($Run, [int]$TimeoutMs = $script:ReadyTimeoutMs)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Run.Pending.Wait(50)) {
      $line = $Run.Pending.Result
      if ($null -eq $line) { return $null }
      $Run.Lines.Add($line)
      if ($line -match '^READY (\d+)$') { return [int64]$Matches[1] }
      $Run.Pending = $Run.Process.StandardError.ReadLineAsync()
    } elseif ($Run.Process.HasExited) { return $null }
  }
  return $null
}
function Invoke-Capture {
  param([string]$Scenario = '', [string[]]$HelperArguments, [int]$BeforeMs = 0, [int]$AfterMs = $script:RunMs, [string]$GateFile = '')
  $run = Start-Helper -HelperArguments $HelperArguments
  $run.ReadyPid = Wait-Ready -Run $run
  $prefix = ''
  if ($Scenario) { $prefix = $Scenario + ' | ' }
  if ($null -eq $run.ReadyPid) {
    if (-not (Stop-Helper -Run $run)) { Write-Fail ($prefix + 'the helper could not be stopped or its stdout capture never finished') }
    Write-Fail ($prefix + 'the helper was not READY (exit=' + $run.ExitCode + ', stderr=' + (Get-StderrText -Run $run) + ')')
    return $run
  }
  if ($BeforeMs -gt 0) { Start-Sleep -Milliseconds $BeforeMs }
  if ($GateFile) { New-Item -ItemType File -Path $GateFile -Force | Out-Null }
  if ($AfterMs -gt 0) { Start-Sleep -Milliseconds $AfterMs }
  if ($run.Process.HasExited) { Write-Fail ($prefix + 'the helper exited before the scheduled capture stop (exit=' + $run.Process.ExitCode + '); the capture window is incomplete') }
  if (Stop-Helper -Run $run) { $run.Bytes = $run.Output.ToArray() }
  else { Write-Fail ($prefix + 'the helper could not be stopped or its stdout capture never finished') }
  return $run
}
function Get-Amplitudes {
  param([byte[]]$Pcm, [double]$Seconds = 1.5)
  $tailFrames = [int]($Seconds * $script:Rate)
  $amplitudes = @{}
  foreach ($frequency in $script:ToneFrequencies) {
    $values = [double[]]::new($script:Channels)
    for ($channel = 0; $channel -lt $script:Channels; $channel++) { $values[$channel] = [SharkordAudioSmoke.Tone]::Amplitude($Pcm, $script:Channels, $script:Rate, $frequency, $channel, $tailFrames) }
    $amplitudes[$frequency] = $values
  }
  $frames = [int]($Pcm.Length / $script:FrameBytes); if ($frames -gt $tailFrames) { $frames = $tailFrames }
  Write-Host ('    pcm: ' + (Num -Value ($Pcm.Length / ($script:Rate * $script:FrameBytes)) -Format 'F2') + ' s captured, measuring the last ' + (Num -Value $Seconds -Format 'F1') + ' s (' + $frames + ' frames)')
  return [pscustomobject]@{ Amplitudes = $amplitudes; Frames = $frames }
}
function Assert-Tones {
  param([string]$Scenario, $Measure, [hashtable]$Expect)
  $wantsPresent = $false
  foreach ($expected in $Expect.Values) { if ($expected) { $wantsPresent = $true } }
  if ($wantsPresent -and $Measure.Frames -lt [int]($script:Rate * 0.2)) { Write-Fail ($Scenario + ' | only ' + $Measure.Frames + ' frames captured; the helper produced no usable PCM') }
  foreach ($frequency in $script:ToneFrequencies) {
    if (-not $Expect.ContainsKey($frequency)) { continue }
    $values = $Measure.Amplitudes[$frequency]
    $minimum = [Math]::Min($values[0], $values[1]); $maximum = [Math]::Max($values[0], $values[1])
    if ($Expect[$frequency]) { $ok = $minimum -ge $script:PresentThreshold; $expectation = 'present >= ' + (Num -Value $script:PresentThreshold) }
    else { $ok = $maximum -lt $script:AbsentThreshold; $expectation = 'absent < ' + (Num -Value $script:AbsentThreshold) }
    $line = '    ' + (Num -Value $frequency -Format 'F0') + ' Hz ' + $script:ToneLabels[$frequency] + ': L=' + (Num -Value $values[0]) + ' R=' + (Num -Value $values[1]) + ' -> ' + $expectation + ' -> ' + $(if ($ok) { 'PASS' } else { 'FAIL' })
    if ($ok) { Write-Host $line -ForegroundColor Green }
    else { Write-Host $line -ForegroundColor Red; $script:Failures.Add($Scenario + ' | ' + $line.Trim()) }
  }
}
function Invoke-Scenario {
  param([string]$Scenario, [string[]]$HelperArguments, [int64]$ExpectedPid, [hashtable]$Expect, [int]$BeforeMs = 0, [int]$AfterMs = $script:RunMs, [string]$GateFile = '')
  Write-Scenario $Scenario
  $run = Invoke-Capture -Scenario $Scenario -HelperArguments $HelperArguments -BeforeMs $BeforeMs -AfterMs $AfterMs -GateFile $GateFile
  if ($null -eq $run.ReadyPid -or $null -eq $run.Bytes) { return }
  if ($run.ReadyPid -ne $ExpectedPid) { Write-Fail ($Scenario + ' | READY pid ' + $run.ReadyPid + ', expected ' + $ExpectedPid) }
  else { Write-Pass ($Scenario + ' | READY ' + $run.ReadyPid) }
  Assert-Tones -Scenario $Scenario -Measure (Get-Amplitudes -Pcm $run.Bytes) -Expect $Expect
}
function Invoke-Refusal {
  param([string]$Scenario, [string[]]$HelperArguments)
  Write-Scenario $Scenario
  $run = Start-Helper -HelperArguments $HelperArguments
  $exited = $run.Process.WaitForExit(15000)
  $stopped = Stop-Helper -Run $run
  $stderrText = Get-StderrText -Run $run
  $problems = New-Object System.Collections.Generic.List[string]
  if (-not $exited) { $problems.Add('kept running instead of refusing') }
  if (-not $stopped) { $problems.Add('the helper could not be stopped or its stdout capture never finished') }
  if ($run.Copied -and $run.Output.Length -ne 0) { $problems.Add('wrote ' + $run.Output.Length + ' PCM bytes') }
  if ($exited -and $run.ExitCode -ne 2) { $problems.Add('exit ' + $run.ExitCode + ' instead of 2') }
  if ($stderrText -match 'READY \d+') { $problems.Add('reported READY') }
  if ($problems.Count -gt 0) { Write-Fail ($Scenario + ' | ' + ($problems -join '; ') + ' | stderr: ' + $stderrText) }
  else { Write-Pass ($Scenario + ' | exit 2, no READY, no PCM; stderr: ' + $stderrText) }
}
function New-HelperArguments {
  param([int64]$ExcludePid, [int64]$IncludeWindow = 0)
  $arguments = @('--exclude-pid', [string]$ExcludePid)
  if ($IncludeWindow -gt 0) { $arguments += @('--include-window', [string]$IncludeWindow) }
  $arguments += @('--rate', [string]$script:Rate, '--channels', [string]$script:Channels)
  return $arguments
}

try {
  $script:HelperExe = Resolve-HelperPath -Override $HelperPath
  if (-not (Test-Path -LiteralPath $script:HelperExe)) { throw ('the helper is missing: ' + $script:HelperExe + ' - build it first or pass -HelperPath') }
  $script:TempDir = (New-Item -ItemType Directory -Path ([IO.Path]::Combine([IO.Path]::GetTempPath(), ('sharkord-audio-smoke-' + [Guid]::NewGuid().ToString('N')))) | Select-Object -ExpandProperty FullName)
  $script:FixtureExe = Join-Path $script:TempDir 'fixture.exe'
  Compile-Fixture -Source $fixtureSource -ExePath $script:FixtureExe
  if (-not ('SharkordAudioSmoke.Tone' -as [type])) { Add-Type -TypeDefinition $analysisSource -Language CSharp -ErrorAction Stop }
  Write-Host ('helper:  ' + $script:HelperExe)
  Write-Host ('fixture: ' + $script:FixtureExe)

  if ($CheckOnly) {
    Write-Host '    embedded C# compiled and fixture built; no window, tone or audio was activated' -ForegroundColor Green
    Invoke-Refusal -Scenario 'check-only: trailing --include-window is refused' -HelperArguments @('--exclude-pid', [string]$PID, '--rate', '48000', '--channels', '2', '--include-window')
    Invoke-Refusal -Scenario 'check-only: trailing --rate is refused' -HelperArguments @('--exclude-pid', [string]$PID, '--channels', '2', '--rate')
    Invoke-Refusal -Scenario 'check-only: trailing --channels is refused' -HelperArguments @('--exclude-pid', [string]$PID, '--rate', '48000', '--channels')
  } else {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $gateFile = Join-Path $script:TempDir 'tone-enabled.flag'
    Write-Scenario 'fixtures: simulated Sharkord (997 Hz), shared app (1493 Hz), unrelated app (2137 Hz)'
    $sim = Start-Fixture -Role 'sim-sharkord' -Tone 997.0
    $shared = Start-Fixture -Role 'shared-app' -Tone 1493.0 -GateFile $gateFile
    $unrelated = Start-Fixture -Role 'unrelated-app' -Tone 2137.0
    Write-Host ('    roots: sim=' + $sim.FixturePid + ' (hwnd ' + $sim.Hwnd + ', child ' + $sim.ChildPid + '), shared=' + $shared.FixturePid + ' (hwnd ' + $shared.Hwnd + ', child ' + $shared.ChildPid + '), unrelated=' + $unrelated.FixturePid + ' (hwnd ' + $unrelated.Hwnd + ', child ' + $unrelated.ChildPid + ')')

    $scenario = 'scenario 1 (positive control: screen capture excluding the unrelated app)'
    Write-Scenario $scenario
    $run = Invoke-Capture -Scenario $scenario -HelperArguments (New-HelperArguments -ExcludePid $unrelated.FixturePid)
    if ($null -ne $run.ReadyPid -and $null -ne $run.Bytes) {
      if ($run.ReadyPid -ne $unrelated.FixturePid) { Write-Fail ($scenario + ' | READY pid ' + $run.ReadyPid + ', expected ' + $unrelated.FixturePid) }
      else { Write-Pass ($scenario + ' | READY ' + $run.ReadyPid) }
      $measure = Get-Amplitudes -Pcm $run.Bytes
      $reference = [Math]::Min($measure.Amplitudes[997.0][0], $measure.Amplitudes[997.0][1])
      if ($reference -lt $script:AudibleFloor) {
        Write-Fail ($scenario + ' | the 997 Hz simulated-Sharkord tone measured ' + (Num -Value $reference) + ', below the floor ' + (Num -Value $script:AudibleFloor) + '; no audible capture - check the playback device and system volume')
        throw 'the positive control could not hear the simulated Sharkord tone'
      }
      $script:ReferenceAmplitude = $reference
      $script:PresentThreshold = $reference * $script:PresentRatio
      $script:AbsentThreshold = $reference * $script:AbsentRatio
      Write-Pass ($scenario + ' | reference=' + (Num -Value $reference) + ', present >= ' + (Num -Value $script:PresentThreshold) + ', absent < ' + (Num -Value $script:AbsentThreshold))
      Assert-Tones -Scenario $scenario -Measure $measure -Expect @{ 997.0 = $true; 1493.0 = $false; 2137.0 = $false }
    }

    Invoke-Scenario -Scenario 'scenario 2a (window capture of the shared app: READY while it is silent)' -HelperArguments (New-HelperArguments -ExcludePid $sim.FixturePid -IncludeWindow $shared.Hwnd) -ExpectedPid $shared.FixturePid -Expect @{ 997.0 = $false; 1493.0 = $false; 2137.0 = $false } | Out-Null
    Invoke-Scenario -Scenario 'scenario 2b (window capture of the shared app: the tone resumes without a restart)' -HelperArguments (New-HelperArguments -ExcludePid $sim.FixturePid -IncludeWindow $shared.Hwnd) -ExpectedPid $shared.FixturePid -Expect @{ 997.0 = $false; 1493.0 = $true; 2137.0 = $false } -BeforeMs 1200 -AfterMs 2800 -GateFile $gateFile | Out-Null
    if (-not (Test-Path -LiteralPath $gateFile)) { New-Item -ItemType File -Path $gateFile -Force | Out-Null }
    Invoke-Scenario -Scenario 'scenario 3 (screen capture excluding the simulated Sharkord)' -HelperArguments (New-HelperArguments -ExcludePid $sim.FixturePid) -ExpectedPid $sim.FixturePid -Expect @{ 997.0 = $false; 1493.0 = $true; 2137.0 = $true } | Out-Null
    Invoke-Scenario -Scenario 'scenario 4 (window capture of the shared app includes only its tree)' -HelperArguments (New-HelperArguments -ExcludePid $sim.FixturePid -IncludeWindow $shared.Hwnd) -ExpectedPid $shared.FixturePid -Expect @{ 997.0 = $false; 1493.0 = $true; 2137.0 = $false } | Out-Null

    Invoke-Refusal -Scenario 'scenario 5a (including the excluded app window is refused)' -HelperArguments (New-HelperArguments -ExcludePid $sim.FixturePid -IncludeWindow $sim.Hwnd)
    $script:Scratch = New-ScratchWindow
    try { Invoke-Refusal -Scenario 'scenario 5b (including the harness window, an ancestor of the helper, is refused)' -HelperArguments (New-HelperArguments -ExcludePid $sim.FixturePid -IncludeWindow $script:Scratch.Handle) }
    finally { try { $script:Scratch.Form.Close() } catch { }; $script:Scratch = $null }
    $scratch = New-ScratchWindow -Destroy
    Invoke-Refusal -Scenario 'scenario 5c (including a destroyed window is refused)' -HelperArguments (New-HelperArguments -ExcludePid $sim.FixturePid -IncludeWindow $scratch.Handle)
  }
} catch {
  Write-Host ('FATAL: ' + $_.Exception.Message) -ForegroundColor Red
  $script:ExitCode = 1
} finally {
  foreach ($run in $script:Runs) { Stop-Helper -Run $run | Out-Null }
  if ($script:Failures.Count -gt 0) { Show-FixtureStderr }
  foreach ($fixture in $script:Fixtures) {
    try { if (-not $fixture.Process.HasExited) { $fixture.Process.Kill() } } catch { }
    try { if ($fixture.ChildPid -gt 0) { Stop-Process -Id $fixture.ChildPid -Force -ErrorAction SilentlyContinue } } catch { }
    try { $null = $fixture.Process.WaitForExit(5000) } catch { }
    try { $fixture.Process.Dispose() } catch { }
    Write-Host ('    stopped fixture ' + $fixture.Role + ' (root ' + $fixture.FixturePid + ', child ' + $fixture.ChildPid + ')')
  }
  if ($script:Scratch) { try { $script:Scratch.Form.Close() } catch { }; $script:Scratch = $null }
  if ($script:TempDir -and (Test-Path -LiteralPath $script:TempDir)) {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
      try { Remove-Item -LiteralPath $script:TempDir -Recurse -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 400 }
    }
    if (Test-Path -LiteralPath $script:TempDir) { Write-Host ('    leftover temp directory: ' + $script:TempDir) -ForegroundColor Yellow }
  }
}

if ($script:Failures.Count -gt 0) { $script:ExitCode = 1 }
Write-Host ''
if ($script:ExitCode -ne 0) {
  Write-Host ('windows audio smoke: FAIL, ' + $script:Failures.Count + ' failure(s)') -ForegroundColor Red
  foreach ($failure in $script:Failures) { Write-Host ('  - ' + $failure) -ForegroundColor Red }
} elseif ($CheckOnly) { Write-Host 'windows audio smoke: check-only - fixture compiled; audio not tested (no window, tone or audio activation was attempted)' -ForegroundColor Green }
else { Write-Host ('windows audio smoke: PASS (reference ' + (Num -Value $script:ReferenceAmplitude) + ')') -ForegroundColor Green }
exit $script:ExitCode
