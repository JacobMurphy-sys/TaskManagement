' Starts the CI Manager in the background (no console window) and opens it
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

If Not IsRunning() Then
  If sh.Run("cmd /c where node", 0, True) <> 0 Then
    MsgBox "Node.js was not found. Install it from https://nodejs.org and try again.", vbExclamation, "CI Manager"
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
    If sh.Run("cmd /c echo Installing CI Manager dependencies... && npm install", 1, True) <> 0 Then
      MsgBox "'npm install' failed. Try running start.bat to see the error.", vbExclamation, "CI Manager"
      WScript.Quit 1
    End If
  End If

  ' 0 = hidden window, False = don't wait for it to finish.
  sh.Run "node src\server.js", 0, False

  For i = 1 To 30
    WScript.Sleep 500
    If IsRunning() Then Exit For
  Next
  If Not IsRunning() Then
    MsgBox "The CI Manager didn't start." & vbCrLf & vbCrLf & _
      "Run start.bat to see the error, or check the newest file in the 'logs' folder.", vbExclamation, "CI Manager"
    WScript.Quit 1
  End If
End If

sh.Run url

' True if the CI Manager answers on its port.
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
