[Setup]
AppId={{144B189C-1153-4E77-A53D-47B86019CB8F}
AppName=RemoteControl
AppVersion=0.5.0
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
