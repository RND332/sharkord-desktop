param(
    [ValidateSet('foreground', 'background')][string]$Mode = 'background',
    [Int64]$TargetWindow = 0
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This input fixture requires Windows.' }

Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
public static class ShortcutInputFixture {
    [StructLayout(LayoutKind.Sequential)] struct MouseInput {
        public int dx, dy;
        public uint mouseData, flags, time;
        public UIntPtr extraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct KeyboardInput {
        public ushort key, scan;
        public uint flags, time;
        public UIntPtr extraInfo;
    }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion {
        [FieldOffset(0)] public MouseInput mouse;
        [FieldOffset(0)] public KeyboardInput keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] struct Input {
        public uint type;
        public InputUnion data;
    }
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static void Key(ushort key, bool up) {
        Input input = new Input();
        input.type = 1;
        input.data.keyboard.key = key;
        input.data.keyboard.flags = up ? 2u : 0u;
        if (SendInput(1, new Input[]{input}, Marshal.SizeOf(typeof(Input))) != 1)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput failed");
    }
    static void Shortcut(ushort primary) {
        try {
            Key(0x11, false);
            Key(0x10, false);
            for (int repeat = 0; repeat < 5; repeat++) {
                Key(primary, false);
                Thread.Sleep(70);
            }
        } finally {
            Key(primary, true);
            Key(0x10, true);
            Key(0x11, true);
        }
        Thread.Sleep(150);
    }
    static void Send(IntPtr expected) {
        if (GetForegroundWindow() != expected) throw new Exception("Fixture does not own keyboard focus");
        Shortcut(0x4D);
        Shortcut(0x44);
        if (GetForegroundWindow() != expected) throw new Exception("Shortcut stole foreground focus");
    }
    public static void Run(bool background, long target) {
        if (!background) { Send(new IntPtr(target)); return; }
        using (Form form = new Form()) {
            form.Text = "Sharkord keyboard focus fixture";
            form.Width = 400;
            form.Height = 180;
            form.TopMost = true;
            Exception failure = null;
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 500;
            timer.Tick += delegate {
                timer.Stop();
                try { Send(form.Handle); } catch (Exception error) { failure = error; }
                form.Close();
            };
            form.Shown += delegate { form.Activate(); timer.Start(); };
            Application.Run(form);
            timer.Dispose();
            if (failure != null) throw failure;
        }
    }
}
'@
[ShortcutInputFixture]::Run($Mode -eq 'background', $TargetWindow)
@{ foregroundVerified = $true; mode = $Mode; combinations = 2; repeatedKeyDowns = 5 } | ConvertTo-Json -Compress
