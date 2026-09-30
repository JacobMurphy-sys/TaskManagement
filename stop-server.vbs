' Stops the CI Manager when it's running in the background (started by start-hidden.vbs).
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
Else
  MsgBox "The CI Manager doesn't seem to be running (nothing answered on port " & port & ").", vbInformation, "CI Manager"
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
