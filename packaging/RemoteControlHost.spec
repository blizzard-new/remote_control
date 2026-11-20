# Build from the project root with python -m PyInstaller packaging/RemoteControlHost.spec.
from pathlib import Path

project = Path(SPECPATH).parent
analysis = Analysis(
    [str(project / "scripts" / "windows_host.py")],
    pathex=[str(project)],
    datas=[(str(project / "web"), "web")],
    hiddenimports=[],
)
archive = PYZ(analysis.pure)
exe = EXE(
    archive, analysis.scripts, analysis.binaries, analysis.datas, [],
    name="RemoteControlHost",
    console=True,
    upx=False,
)
