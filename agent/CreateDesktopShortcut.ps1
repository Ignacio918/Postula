$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $repoRoot '.postula-agent\postula-agent-config.json'
$iconPath = Join-Path $repoRoot 'assets\postula-icon.ico'
$appId = 'Ignacio.Postula.Desktop'

foreach ($requiredFile in @($profilePath, $iconPath, (Join-Path $PSScriptRoot 'PostulaDesktop.ps1'))) {
  if (-not (Test-Path -LiteralPath $requiredFile)) { throw "Falta el archivo requerido: $requiredFile" }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PostulaPropertyKey {
  public Guid FormatId;
  public uint PropertyId;
}

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PostulaPropVariant {
  [FieldOffset(0)] public ushort VariantType;
  [FieldOffset(8)] public IntPtr Pointer;
}

[ComImport]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface PostulaPropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index, out PostulaPropertyKey key);
  [PreserveSig] int GetValue(ref PostulaPropertyKey key, out PostulaPropVariant value);
  [PreserveSig] int SetValue(ref PostulaPropertyKey key, ref PostulaPropVariant value);
  [PreserveSig] int Commit();
}

public static class PostulaShortcutIdentity {
  private static PostulaPropertyKey AppIdKey() {
    return new PostulaPropertyKey {
      FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
      PropertyId = 5
    };
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  private static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bindContext, uint flags, ref Guid iid, out PostulaPropertyStore store);

  [DllImport("ole32.dll", PreserveSig = true)]
  private static extern int PropVariantClear(ref PostulaPropVariant value);

  [DllImport("shell32.dll", PreserveSig = true)]
  private static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out PostulaPropertyStore store);

  private static PostulaPropertyStore OpenStore(string path) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    PostulaPropertyStore store;
    int result = SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    return store;
  }

  public static void SetAppId(string path, string appId) {
    PostulaPropertyStore store = OpenStore(path);
    PostulaPropertyKey key = AppIdKey();
    int result;
    PostulaPropVariant value = new PostulaPropVariant {
      VariantType = 31,
      Pointer = Marshal.StringToCoTaskMemUni(appId)
    };
    try {
      result = store.SetValue(ref key, ref value);
      if (result < 0) Marshal.ThrowExceptionForHR(result);
      result = store.Commit();
      if (result < 0) Marshal.ThrowExceptionForHR(result);
    } finally {
      PropVariantClear(ref value);
      Marshal.ReleaseComObject(store);
    }
  }

  public static string GetAppId(string path) {
    PostulaPropertyStore store = OpenStore(path);
    PostulaPropertyKey key = AppIdKey();
    PostulaPropVariant value;
    try {
      int result = store.GetValue(ref key, out value);
      if (result < 0) Marshal.ThrowExceptionForHR(result);
      try { return value.VariantType == 31 ? Marshal.PtrToStringUni(value.Pointer) : null; }
      finally { PropVariantClear(ref value); }
    } finally {
      Marshal.ReleaseComObject(store);
    }
  }

  public static string GetWindowAppId(IntPtr window) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    PostulaPropertyStore store;
    int result = SHGetPropertyStoreForWindow(window, ref iid, out store);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    PostulaPropertyKey key = AppIdKey();
    PostulaPropVariant value;
    try {
      result = store.GetValue(ref key, out value);
      if (result < 0) Marshal.ThrowExceptionForHR(result);
      try { return value.VariantType == 31 ? Marshal.PtrToStringUni(value.Pointer) : null; }
      finally { PropVariantClear(ref value); }
    } finally {
      Marshal.ReleaseComObject(store);
    }
  }
}
'@

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Postula.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'PostulaDesktop.ps1')`" -Config `".postula-agent\postula-agent-config.json`""
$shortcut.WorkingDirectory = $repoRoot
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = 'Abrir Postula y ver la actividad del agente'
$shortcut.WindowStyle = 1
$shortcut.Save()

[PostulaShortcutIdentity]::SetAppId($shortcutPath, $appId)
if ([PostulaShortcutIdentity]::GetAppId($shortcutPath) -ne $appId) { throw 'Windows no guardó la identidad de Postula en el acceso directo.' }
Write-Output "Acceso directo Postula actualizado: $shortcutPath"
