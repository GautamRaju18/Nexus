' Launches the Jarvis web cockpit with NO visible console window.
' Self-locating: works regardless of where the jarvis folder lives.
' Used by the auto-start shortcut (see install-autostart.ps1).

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)   ' ...\jarvis\scripts
root = fso.GetParentFolderName(scriptDir)                     ' ...\jarvis

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
' Window style 0 = hidden, False = don't wait. The server opens the browser itself.
sh.Run "node --experimental-sqlite --env-file-if-exists=.env --import tsx src\surfaces\web.ts", 0, False
