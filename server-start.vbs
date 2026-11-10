' Starts SITHUB as the shared server (server-run.bat) in the background, with no window.
' Made for server-install-user.bat (the setup that needs no administrator): a shortcut to this in
' the Windows Startup folder starts the server when that account logs in. If the server is already
' running (server-run.bat is), it does nothing, so running it twice is harmless.
Option Explicit

Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

If RunnerRunning() Then WScript.Quit 0
If sh.Run("cmd /c where node", 0, True) <> 0 Then
  MsgBox "Node.js was not found, so the SITHUB server can't start. Install it from https://nodejs.org.", vbExclamation, "SITHUB server"
  WScript.Quit 1
End If
' 0 = hidden window, False = don't wait. server-run.bat keeps it going and writes logs\server-run.log.
sh.Run "cmd /c """ & dir & "\server-run.bat""", 0, False

' True when server-run.bat is already running for this user (it runs from a copy in %TEMP%).
Function RunnerRunning()
  Dim wmi, procs
  RunnerRunning = False
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'cmd.exe' AND CommandLine LIKE '%cimanager-server-run.bat%'")
  If Err.Number = 0 Then RunnerRunning = (procs.Count > 0)
  On Error GoTo 0
End Function
