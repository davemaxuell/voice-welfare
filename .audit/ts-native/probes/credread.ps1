param([Parameter(Mandatory = $true)][string]$Target)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CredNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
}
"@
$p = [IntPtr]::Zero
if (-not [CredNative]::CredRead($Target, 1, 0, [ref]$p)) {
  '{"found":false,"win32Error":' + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + '}'
  exit 0
}
$c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [Type][CredNative+CREDENTIAL])
$bytes = New-Object byte[] $c.CredentialBlobSize
if ($c.CredentialBlobSize -gt 0) { [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize) }
$hex = ($bytes | Select-Object -First 512 | ForEach-Object { $_.ToString('x2') }) -join ''
[pscustomobject]@{ found = $true; type = $c.Type; userName = $c.UserName; blobSize = $c.CredentialBlobSize; persist = $c.Persist; fullHex = $hex } | ConvertTo-Json -Compress
[CredNative]::CredFree($p)
