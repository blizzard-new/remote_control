[Setup]
AppId={{144B189C-1153-4E77-A53D-47B86019CB8F}
AppName=RemoteControl
AppVersion=0.5.8
DefaultDirName={localappdata}\Programs\RemoteControl
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=RemoteControl-Setup-Windows-x64
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
RestartApplications=no

[Files]
Source: "..\dist\RemoteControlHost.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\RemoteControl"; Filename: "{app}\RemoteControlHost.exe"

[Run]
Filename: "{app}\RemoteControlHost.exe"; Description: "Open RemoteControl"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\RemoteControlHost.exe"; Parameters: "--exit"; Flags: runhidden; RunOnceId: "StopUniwayRemote"

[Code]
const
  HostMutexName = 'Local\UniwayRemote.Desktop';
  StartupKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  StartupName = 'UniwayRemote';

function OpenMutex(DesiredAccess: LongWord; Inherit: Boolean; Name: String): THandle;
  external 'OpenMutexW@kernel32.dll stdcall';
function OpenEvent(DesiredAccess: LongWord; Inherit: Boolean; Name: String): THandle;
  external 'OpenEventW@kernel32.dll stdcall';
function SetEvent(EventHandle: THandle): Boolean;
  external 'SetEvent@kernel32.dll stdcall';
function WaitForSingleObject(Handle: THandle; Milliseconds: LongWord): LongWord;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function ReleaseMutex(Handle: THandle): Boolean;
  external 'ReleaseMutex@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function WaitForHostToExit(Handle: THandle; Timeout: LongWord): Boolean;
var
  Status: LongWord;
begin
  Status := WaitForSingleObject(Handle, Timeout);
  Result := (Status = 0) or (Status = 128);
  if Result then
    ReleaseMutex(Handle);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  HostMutex, ExitEvent: THandle;
begin
  { An installed copy and a portable copy share the same session. Stop either
    before replacing files or launching the new dashboard. }
  Result := 'Uniway Remote is still running. Select Exit in its notification area menu and try again.';
  HostMutex := OpenMutex($00100001, False, HostMutexName);
  if HostMutex = 0 then
  begin
    if DLLGetLastError = 2 then
      Result := '';
    exit;
  end;

  try
    if WaitForHostToExit(HostMutex, 0) then
    begin
      Result := '';
      exit;
    end;
    ExitEvent := OpenEvent($0002, False, HostMutexName + '.exit');
    if ExitEvent <> 0 then
    begin
      try
        Log('Asking the existing Uniway Remote instance to stop.');
        if SetEvent(ExitEvent) and WaitForHostToExit(HostMutex, 20000) then
          Result := '';
      finally
        CloseHandle(ExitEvent);
      end;
    end
    else if WaitForHostToExit(HostMutex, 0) then
      Result := '';
  finally
    CloseHandle(HostMutex);
  end;
end;

procedure CurStepChanged(Step: TSetupStep);
begin
  if (Step = ssPostInstall) and RegValueExists(HKCU, StartupKey, StartupName) then
    RegWriteStringValue(HKCU, StartupKey, StartupName,
      '"' + ExpandConstant('{app}\RemoteControlHost.exe') + '" --background');
end;

procedure CurUninstallStepChanged(Step: TUninstallStep);
begin
  if Step = usUninstall then
    RegDeleteValue(HKCU, StartupKey, StartupName);
end;
