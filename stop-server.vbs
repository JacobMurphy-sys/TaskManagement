' Stops SITHUB when it's running in the background (started by start-hidden.vbs).
' A copy that's frozen (holding its port, not answering) it offers to end (scripts\free-port.js).
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
  MsgBox "SITHUB stopped.", vbInformation, "SITHUB"
Else
  ' nothing answered: not running at all, or frozen (holding the port without answering)
  Select Case PortCheck(False)
    Case 0
      MsgBox "SITHUB isn't running.", vbInformation, "SITHUB"
    Case 1
      MsgBox "SITHUB is running but didn't accept the stop. Use Stop server in its ... menu.", vbInformation, "SITHUB"
    Case Else
      If EndFrozen(port) Then MsgBox "Ended. Port " & port & " is free: start SITHUB again.", vbInformation, "SITHUB"
  End Select
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

' ---- a copy that's frozen: it holds the port but doesn't answer ------------------------------
' Asks scripts\free-port.js (Node, run hidden, the way the app itself is started), which finds the
' frozen copy from the app's own lock file. Returns its exit code: 0 port free, 1 running fine,
' 10 a frozen SITHUB, 11 another program, 12 ended, 13 couldn't end.
Function PortCheck(endIt)
  Dim sh2, cmd
  Set sh2 = CreateObject("WScript.Shell")
  sh2.CurrentDirectory = dir
  cmd = "node scripts\free-port.js"
  If endIt Then cmd = cmd & " --end"
  PortCheck = sh2.Run(cmd, 0, True)
End Function

' Offers to end a frozen SITHUB. True when it was ended (the port is free).
Function EndFrozen(port)
  EndFrozen = False
  Select Case PortCheck(False)
    Case 10
      If MsgBox("SITHUB seems to be frozen: it still holds port " & port & " but isn't answering." & vbCrLf & vbCrLf & _
        "End it now? Anything saved is kept; a change made in the last moments before it froze may be lost.", vbYesNo + vbExclamation, "SITHUB") = vbYes Then
        EndFrozen = (PortCheck(True) = 12)
        If Not EndFrozen Then MsgBox "It couldn't be ended. Restarting Windows frees the port.", vbExclamation, "SITHUB"
      End If
    Case 11
      MsgBox "Port " & port & " is in use by another program, not SITHUB." & vbCrLf & vbCrLf & _
        "Close that program, or put PORT=3001 (say) in the .env file in the app folder.", vbExclamation, "SITHUB"
  End Select
End Function
