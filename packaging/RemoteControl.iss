[Setup]
AppId={{144B189C-1153-4E77-A53D-47B86019CB8F}
AppName=RemoteControl
AppVersion=0.5.9
DefaultDirName={localappdata}\Programs\RemoteControl
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=RemoteControl-Setup-Windows-x64
SetupIconFile=uniway-remote.ico
UninstallDisplayIcon={app}\RemoteControlHost.exe
Compression=lzma2
SolidCompression=yes
CloseApplications=no
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
function CreateFile(Name: String; Access, ShareMode, Security, Disposition,
  Attributes: LongWord; TemplateFile: THandle): THandle;
  external 'CreateFileW@kernel32.dll stdcall';

function WaitForHostToExit(Handle: THandle; Timeout: LongWord): Boolean;
var
  Status: LongWord;
begin
  Status := WaitForSingleObject(Handle, Timeout);
  Result := (Status = 0) or (Status = 128);
  if Result then
    ReleaseMutex(Handle);
end;

function StopRunningHost: Boolean;
var
  HostMutex, ExitEvent: THandle;
begin
  { An installed copy and a portable copy share the same session. Stop either
    before replacing files or launching the new dashboard. }
  Result := False;
  HostMutex := OpenMutex($00100001, False, HostMutexName);
  if HostMutex = 0 then
  begin
    if DLLGetLastError = 2 then
      Result := True;
    exit;
  end;

  try
    if WaitForHostToExit(HostMutex, 0) then
    begin
      Result := True;
      exit;
    end;
    ExitEvent := OpenEvent($0002, False, HostMutexName + '.exit');
    if ExitEvent <> 0 then
    begin
      try
        Log('Asking the existing Uniway Remote instance to stop.');
        if SetEvent(ExitEvent) then
          Result := WaitForHostToExit(HostMutex, 20000);
      finally
        CloseHandle(ExitEvent);
      end;
    end
    else
      Result := WaitForHostToExit(HostMutex, 0);
  finally
    CloseHandle(HostMutex);
  end;
end;

function WaitForInstalledFile: Boolean;
var
  Executable: String;
  Handle: THandle;
  Attempt: Integer;
begin
  Executable := ExpandConstant('{app}\RemoteControlHost.exe');
  Result := True;
  if not FileExists(Executable) then
    exit;

  { The PyInstaller bootstrap process can still hold the executable after
    the application releases its mutex. Check when the file can be replaced. }
  for Attempt := 1 to 100 do
  begin
    Handle := CreateFile(Executable, $40000000, 0, 0, 3, $80, 0);
    if Handle <> THandle(-1) then
    begin
      CloseHandle(Handle);
      exit;
    end;
    Sleep(100);
  end;
  Result := False;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := 'Uniway Remote could not be replaced. Exit Uniway Remote from the notification area and try again.';
  if StopRunningHost and WaitForInstalledFile then
    Result := '';
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
