' Starts the Task Manager in the background (no console window) and opens it
' in your browser. If it's already running, it just opens the browser.
' Put a shortcut to this file in shell:startup to start it when you log in.
Option Explicit

Dim sh, fso, dir, url, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
url = "http://localhost:" & ReadPort() & "/"

If Not IsRunning() Then
  If sh.Run("cmd /c where node", 0, True) <> 0 Then
    MsgBox "Node.js was not found. Install it from https://nodejs.org and try again.", vbExclamation, "Task Manager"
    WScript.Quit 1
  End If

  ' First run: install dependencies (this window is visible so you can see progress).
  If Not fso.FolderExists(dir & "\node_modules") Then
    If sh.Run("cmd /c echo Installing Task Manager dependencies... && npm install", 1, True) <> 0 Then
      MsgBox "'npm install' failed. Try running start.bat to see the error.", vbExclamation, "Task Manager"
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
    MsgBox "The Task Manager didn't start." & vbCrLf & vbCrLf & _
      "Run start.bat to see the error, or check the newest file in the 'logs' folder.", vbExclamation, "Task Manager"
    WScript.Quit 1
  End If
End If

sh.Run url

' True if the Task Manager answers on its port.
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
