# Build from the repository root with PyInstaller.
import sys
from pathlib import Path

project = Path(SPECPATH).parent
analysis = Analysis(
    [str(project / "scripts" / "windows_host.py")],
    pathex=[str(project)],
    binaries=[(str(project / "build" / "libRemoteControlDisplay.dylib"), ".")] if sys.platform == "darwin" else ([(str(project / "build/focus/Release/EditableFocus.dll"), ".")] if sys.platform == "win32" else []),
    datas=[(str(project / "web"), "web")],
    hiddenimports=[],
)
archive = PYZ(analysis.pure)
if sys.platform == "darwin":
    exe = EXE(archive, analysis.scripts, [], exclude_binaries=True,
              name="RemoteControl", console=False, upx=False)
    files = COLLECT(exe, analysis.binaries, analysis.datas, name="RemoteControl", upx=False)
    app = BUNDLE(files, name="RemoteControl.app", bundle_identifier="org.remotecontrol.desktop",
                 version="0.5.6", info_plist={"NSHighResolutionCapable": True})
elif sys.platform == "win32":
    exe = EXE(archive, analysis.scripts, analysis.binaries, analysis.datas, [],
              name="RemoteControlHost", console=True, hide_console="hide-early", upx=False)
else:
    exe = EXE(archive, analysis.scripts, analysis.binaries, analysis.datas, [],
              name="RemoteControlHost", console=True, upx=False)
