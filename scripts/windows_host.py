"""Interactive desktop launcher. The same entry point runs from source or a frozen EXE."""
import argparse
import errno
import ipaddress
import os
from pathlib import Path
import socket
import ssl
import sys
import webbrowser

from cryptography import x509
from cryptography.hazmat.primitives import serialization

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.start_lan import lan_server_args
from server.__main__ import main as run_server


def default_address():
    """Ask the OS which LAN address it would use. No Internet probe is transmitted."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("192.0.2.1", 9))
            return ipaddress.IPv4Address(sock.getsockname()[0])
    except OSError:
        try:
            addresses = socket.getaddrinfo(socket.gethostname(), None, family=socket.AF_INET)
        except OSError:
            return None
        for entry in addresses:
            ip = ipaddress.IPv4Address(entry[4][0])
            if not ip.is_loopback and not ip.is_unspecified:
                return ip
        return None


def select_address():
    detected = default_address()
    if sys.stdin.isatty():
        prompt = f"區網 IPv4（按 Enter 使用 {detected}）" if detected else "輸入這台電腦的區網 IPv4"
        response = input(f"{prompt}：").strip()
        if response:
            return ipaddress.IPv4Address(response)
    if detected is None:
        raise ValueError("無法偵測區網 IPv4。請連上 Wi-Fi 或用 --address 指定位址。")
    return detected


def prepare_windows_trust(ca_path):
    """Let the user review and install a new public CA in the Windows certificate viewer."""
    der = x509.load_pem_x509_certificate(ca_path.read_bytes()).public_bytes(serialization.Encoding.DER)
    if any(encoding == "x509_asn" and cert == der for cert, encoding, _ in ssl.enum_certificates("ROOT")):
        return
    print("請在即將開啟的 Windows 憑證視窗核對指紋，選「安裝憑證」→「目前的使用者」。")
    print("選「將所有憑證放入以下的存放區」，再選「受信任的根憑證授權單位」並完成安裝。", flush=True)
    os.startfile(str(ca_path))
    input("完成後按 Enter 開啟主機控制頁面。")


def open_host(url):
    try:
        if webbrowser.open(url, new=2):
            return
    except (OSError, webbrowser.Error):
        pass
    print("請在這台電腦的 Chrome 或 Edge 貼上上方的主機連結。", flush=True)


def start_online(port, *, on_ready):
    if port is not None and not 0 <= port <= 65535:
        raise ValueError("本機連接埠必須在 0–65535 之間")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        if sys.platform == "win32":
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            listener.bind(("127.0.0.1", 8443 if port is None else port))
        except OSError as error:
            # Windows can report WSAEACCES for a reserved or exclusively held port.
            unavailable = error.errno == errno.EADDRINUSE or getattr(error, "winerror", None) in (10013, 10048)
            if port is not None or not unavailable:
                raise
            listener.bind(("127.0.0.1", 0))
        options = ["--request-control"] if sys.platform == "darwin" else []
        run_server(options, online_socket=listener, on_ready=on_ready)


def main():
    # Redirected output on Windows inherits a legacy code page on some systems.
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and not stream.isatty() and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description="啟動遠端桌面")
    parser.add_argument("--lan", action="store_true", help="使用區域網路與自訂憑證模式")
    parser.add_argument("--address", type=ipaddress.IPv4Address, help="這台電腦的 LAN IPv4")
    parser.add_argument("--port", type=int, help="指定連接埠；跨網路模式可填 0 讓系統分配")
    data_home = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    parser.add_argument("--state-dir", type=Path, default=data_home / "RemoteControlHost" / "identities")
    parser.add_argument("--no-browser", action="store_true", help="僅在主控台顯示連結與公開憑證位置")
    args = parser.parse_args()
    if not args.lan and args.address is None:
        start_online(args.port, on_ready=None if args.no_browser else open_host)
        return 0
    print("將手機或平板連上與這台電腦相同的區網。", flush=True)
    address = args.address or select_address()
    ca_path, server_args = lan_server_args(address, 8443 if args.port is None else args.port, args.state_dir)
    print("三星平板首次連線時，將上方的 trusted-root.crt 傳到平板，在設定中搜尋「安裝憑證」並安裝為 CA 憑證。")
    print("只需傳送 trusted-root.crt 這個公開檔案。請以主機顯示的 SHA-256 指紋核對憑證。")
    print("主機請使用 Chrome 或 Edge，在主機頁面按「選擇畫面並開始分享」，再逐一核准觀看者。")
    print("結束時按 Ctrl+C 關閉主機。", flush=True)
    if sys.platform == "win32" and sys.stdin.isatty() and not args.no_browser:
        prepare_windows_trust(ca_path)
    run_server(server_args, on_ready=None if args.no_browser else open_host)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except (OSError, ValueError, EOFError) as error:
        print(f"無法啟動主機：{error}", file=sys.stderr, flush=True)
        if sys.stdin.isatty():
            input("按 Enter 結束。")
        raise SystemExit(1)
