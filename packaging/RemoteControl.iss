[Setup]
AppId={{144B189C-1153-4E77-A53D-47B86019CB8F}
AppName=RemoteControl
AppVersion=0.5.7
DefaultDirName={localappdata}\Programs\RemoteControl
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=RemoteControl-Setup-Windows-x64
Compression=lzma2
SolidCompression=yes

[Files]
Source: "..\dist\RemoteControlHost.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\RemoteControl"; Filename: "{app}\RemoteControlHost.exe"

[Run]
Filename: "{app}\RemoteControlHost.exe"; Description: "Open RemoteControl"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\RemoteControlHost.exe"; Parameters: "--exit"; Flags: runhidden; RunOnceId: "StopUniwayRemote"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Executable: String;
begin
  Result := '';
  Executable := ExpandConstant('{app}\RemoteControlHost.exe');
  if FileExists(Executable) then
    Exec(Executable, '--exit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurUninstallStepChanged(Step: TUninstallStep);
begin
  if Step = usUninstall then
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'UniwayRemote');
end;
