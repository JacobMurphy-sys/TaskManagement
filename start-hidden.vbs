' Starts SITHUB in the background (no console window) and opens it
' in your browser. If it's already running, it just opens the browser.
' Before starting, it checks GitHub for a newer version; if there is one, CIManager-Setup.bat
' updates it (in a window, so you can see it) and starts it. AUTO_UPDATE=0 in .env turns that off.
' Put a shortcut to this file in shell:startup to start it when you log in.
Option Explicit

Dim sh, fso, dir, url, i, setup
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
url = "http://localhost:" & ReadPort() & "/"

If Not IsRunning() And IsServer() Then
  ' The shared server's PC (HOST in .env answers the network): start it the server's way, through
  ' server-run.bat, which keeps it going, updates it and lets it be restarted from Settings.
  If sh.Run("cmd /c where node", 0, True) <> 0 Then
    MsgBox "Node.js was not found. Install it from https://nodejs.org and try again.", vbExclamation, "SITHUB"
    WScript.Quit 1
  End If
  If fso.FileExists(dir & "\server-start.vbs") Then
    sh.Run "wscript """ & dir & "\server-start.vbs""", 0, True
  Else
    sh.Run "cmd /c """ & dir & "\server-run.bat""", 0, False
  End If
  For i = 1 To 120
    WScript.Sleep 500
    If IsRunning() Then Exit For
  Next
  If Not IsRunning() Then
    MsgBox "The SITHUB server hasn't started yet (it may be updating)." & vbCrLf & vbCrLf & _
      "Give it a minute and try again, or look in logs\server-run.log in " & dir & ".", vbExclamation, "SITHUB"
    WScript.Quit 1
  End If
End If

If Not IsRunning() Then
  If sh.Run("cmd /c where node", 0, True) <> 0 Then
    MsgBox "Node.js was not found. Install it from https://nodejs.org and try again.", vbExclamation, "SITHUB"
    WScript.Quit 1
  End If

  ' A newer version on GitHub: let the setup update and start it. Not when the setup itself
  ' is starting the app (CIM_NOUPDATE), so a failed update can't go round in circles.
  If sh.ExpandEnvironmentStrings("%CIM_NOUPDATE%") <> "1" Then
    setup = SetupFile()
    If setup <> "" Then
      If sh.Run("cmd /c node scripts\check-update.js", 0, True) = 10 Then
        sh.Run "cmd /c """"" & setup & """""", 1, False
        WScript.Quit 0
      End If
    End If
  End If

  ' First run: install dependencies (this window is visible so you can see progress).
  If Not fso.FolderExists(dir & "\node_modules") Then
    If sh.Run("cmd /c echo Installing SITHUB dependencies... && npm install", 1, True) <> 0 Then
      MsgBox "'npm install' failed. Try running start.bat to see the error.", vbExclamation, "SITHUB"
      WScript.Quit 1
    End If
  End If

  ' 0 = hidden window, False = don't wait for it to finish.
  sh.Run "node src\server.js", 0, False

  For i = 1 To 30
    WScript.Sleep 500
    If IsRunning() Then Exit For
  Next
  ' didn't come up: a frozen copy still holding the port? Offer to end it, then start again.
  If Not IsRunning() Then
    If EndFrozen(ReadPort()) Then
      sh.Run "node src\server.js", 0, False
      For i = 1 To 30
        WScript.Sleep 500
        If IsRunning() Then Exit For
      Next
    End If
  End If
  If Not IsRunning() Then
    MsgBox "SITHUB didn't start." & vbCrLf & vbCrLf & _
      "Run start.bat to see the error, or check the newest file in " & sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\CIManager\logs" & _
      " (the app's log; logs in the app folder are only the shared server's).", vbExclamation, "SITHUB"
    WScript.Quit 1
  End If
End If

sh.Run url

' True on the shared server's PC: HOST in .env is set to answer the network (server-install).
Function IsServer()
  Dim f, line, h
  IsServer = False
  If fso.FileExists(dir & "\.env") Then
    Set f = fso.OpenTextFile(dir & "\.env", 1)
    Do Until f.AtEndOfStream
      line = Trim(f.ReadLine)
      If LCase(Left(line, 5)) = "host=" Then
        h = LCase(Trim(Mid(line, 6)))
        IsServer = (h <> "" And h <> "127.0.0.1" And h <> "localhost" And h <> "::1")
      End If
    Loop
    f.Close
  End If
End Function

' True if SITHUB answers on its port.
Function IsRunning()
  Dim http
  IsRunning = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.open "GET", url & "api/health", False
  http.send
  If Err.Number = 0 Then
    If http.status = 200 And InStr(http.responseText, "taskmanager") > 0 Then IsRunning = True
  End If
  On Error GoTo 0
End Function

' CIManager-Setup.bat next to the app folder (installed by it), or in it (a clone), or "".
Function SetupFile()
  SetupFile = ""
  If fso.FileExists(fso.GetParentFolderName(dir) & "\CIManager-Setup.bat") Then
    SetupFile = fso.GetParentFolderName(dir) & "\CIManager-Setup.bat"
  ElseIf fso.FileExists(dir & "\CIManager-Setup.bat") Then
    SetupFile = dir & "\CIManager-Setup.bat"
  End If
End Function

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
