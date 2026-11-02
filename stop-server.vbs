' Stops the CI Manager when it's running in the background (started by start-hidden.vbs).
' A copy that's frozen (holding its port, not answering) it offers to end.
' You can also use the "Stop server" button at the bottom of the app's sidebar.
Option Explicit

Dim fso, dir, port, http
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
port = ReadPort()

Dim stopped
stopped = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1000, 1000, 3000, 3000
http.open "POST", "http://localhost:" & port & "/api/shutdown", False
http.setRequestHeader "X-Requested-With", "TaskManager"
http.send
' (Checked in two steps: with Resume Next, an error inside an If condition runs the If body.)
If Err.Number = 0 Then stopped = (http.status = 200)
On Error GoTo 0

If stopped Then
  MsgBox "CI Manager stopped.", vbInformation, "CI Manager"
ElseIf PortOwner(port) = "" Then
  MsgBox "The CI Manager isn't running (nothing is using port " & port & ").", vbInformation, "CI Manager"
ElseIf EndFrozen(port) Then
  MsgBox "Ended. Port " & port & " is free: start the CI Manager again.", vbInformation, "CI Manager"
ElseIf PortOwner(port) <> "" Then
  MsgBox "Port " & port & " is still in use. Restarting Windows frees it.", vbExclamation, "CI Manager"
End If

' PORT from .env, or 3000.
Function ReadPort()
  Dim f, line
  ReadPort = "3000"
  If fso.FileExists(dir & "\.env") Then
    Set f = fso.OpenTextFile(dir & "\.env", 1)
    Do Until f.AtEndOfStream
      line = Trim(f.ReadLine)
      If LCase(Left(line, 5)) = "port=" Then ReadPort = Trim(Mid(line, 6))
    Loop
    f.Close
  End If
End Function

' ---- a copy that's frozen: it holds the port but doesn't answer ----------------------------
' The process listening on the port: "pid|program" (e.g. "1234|node.exe"), or "" when none.
Function PortOwner(port)
  Dim sh2, tmp, f, line
  PortOwner = ""
  Set sh2 = CreateObject("WScript.Shell")
  tmp = fso.GetSpecialFolder(2) & "\cimanager-port.txt"
  If fso.FileExists(tmp) Then fso.DeleteFile tmp, True
  ' Get-NetTCPConnection, not netstat: netstat's words change with the Windows language
  sh2.Run "powershell -NoProfile -Command ""$o = ''; $c = Get-NetTCPConnection -LocalPort " & port & " -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; " & _
    "if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; $o = [string]$c.OwningProcess + '|' + $(if ($p) { $p.ProcessName + '.exe' } else { 'an unknown program' }) }; " & _
    "Set-Content -Encoding ASCII -LiteralPath '" & Replace(tmp, "'", "''") & "' -Value $o""", 0, True
  If fso.FileExists(tmp) Then
    Set f = fso.OpenTextFile(tmp, 1)
    If Not f.AtEndOfStream Then line = Trim(f.ReadLine)
    f.Close
    fso.DeleteFile tmp, True
    If InStr(line, "|") > 1 Then PortOwner = line
  End If
End Function

' Offers to end what holds the port. True when it was ended.
Function EndFrozen(port)
  Dim owner, pid, nm, ask, sh2, i
  EndFrozen = False
  owner = PortOwner(port)
  If owner = "" Then Exit Function
  pid = Split(owner, "|")(0)
  nm = Split(owner, "|")(1)
  If LCase(nm) = "node.exe" Then
    ask = "The CI Manager seems to be frozen: it still holds port " & port & " but isn't answering (Node.js, process " & pid & ")." & vbCrLf & vbCrLf & _
      "End it now? Anything saved is kept. A change made in the last moments before it froze may be lost."
  Else
    ask = "Port " & port & " is held by " & nm & " (process " & pid & "), which isn't the CI Manager." & vbCrLf & vbCrLf & _
      "End " & nm & "? Only say Yes if you know what it is. Otherwise close it yourself, or set PORT=3001 (say) in the .env file in the app folder."
  End If
  If MsgBox(ask, vbYesNo + vbExclamation, "CI Manager") <> vbYes Then Exit Function
  Set sh2 = CreateObject("WScript.Shell")
  sh2.Run "cmd /c taskkill /F /PID " & pid, 0, True
  For i = 1 To 10
    WScript.Sleep 300
    If PortOwner(port) = "" Then
      EndFrozen = True
      Exit Function
    End If
  Next
End Function
