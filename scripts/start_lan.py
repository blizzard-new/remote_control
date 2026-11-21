"""Create a private LAN certificate and start this computer's desktop sharing service."""
import argparse
import ipaddress
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


PROJECT = Path(__file__).resolve().parents[1]


def certificate_for(ip, state):
    """Keep a single stable identity per address. Only the server key is persisted."""
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = state / str(ip)
    if not target.exists():
        # Concurrent launches only publish a complete identity. Keep the CA signing key in memory.
        with tempfile.TemporaryDirectory(dir=state) as temporary:
            staging = Path(temporary) / "identity"
            staging.mkdir(mode=0o700)
            now = datetime.now(timezone.utc)
            ca_key = ec.generate_private_key(ec.SECP256R1())
            server_key = ec.generate_private_key(ec.SECP256R1())
            ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"Remote Control LAN {ip}")])
            ca_id = x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key())
            authority = x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(ca_id)
            common = (x509.CertificateBuilder()
                      .issuer_name(ca_name)
                      .add_extension(authority, critical=False)
                      .not_valid_before(now - timedelta(minutes=5)))
            ca = (common.subject_name(ca_name).public_key(ca_key.public_key())
                  .serial_number(x509.random_serial_number())
                  .not_valid_after(now + timedelta(days=365))
                  .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                  .add_extension(ca_id, critical=False)
                  .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False),
                                 critical=True)
                  .sign(ca_key, hashes.SHA256()))
            hosts = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                     x509.IPAddress(ipaddress.ip_address("::1")), x509.IPAddress(ip)]
            leaf = (common.subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, str(ip))]))
                    .public_key(server_key.public_key()).serial_number(x509.random_serial_number())
                    .not_valid_after(now + timedelta(days=180))
                    .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                    .add_extension(x509.SubjectKeyIdentifier.from_public_key(server_key.public_key()), critical=False)
                    .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False),
                                   critical=True)
                    .add_extension(x509.SubjectAlternativeName(hosts), critical=False)
                    .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                    .sign(ca_key, hashes.SHA256()))
            pem = serialization.Encoding.PEM
            (staging / "trusted-root.crt").write_bytes(ca.public_bytes(pem))
            (staging / "server.crt").write_bytes(leaf.public_bytes(pem))
            with os.fdopen(os.open(staging / "server.key", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
                           "wb") as key_file:
                key_file.write(server_key.private_bytes(pem, serialization.PrivateFormat.PKCS8,
                                                        serialization.NoEncryption()))
            try:
                staging.rename(target)
            except OSError:
                if not target.is_dir():
                    raise
    return target


def lan_server_args(address, port, state):
    if address.is_loopback or address.is_multicast or address.is_unspecified:
        raise ValueError("請填入電腦的區網 IPv4 位址")
    if not 1 <= port <= 65535:
        raise ValueError("連接埠必須在 1–65535 之間")
    directory = certificate_for(address, state.resolve())
    ca_path = directory / "trusted-root.crt"
    ca = x509.load_pem_x509_certificate(ca_path.read_bytes())
    leaf = x509.load_pem_x509_certificate((directory / "server.crt").read_bytes())
    if leaf.not_valid_after_utc <= datetime.now(timezone.utc):
        raise ValueError("主機憑證已過期。請用 --state-dir 指定新目錄，再於裝置上信任新根憑證。")
    print(f"觀看端網址  https://{address}:{port}/", flush=True)
    print(f"請在主機與觀看裝置上信任此公開根憑證  {ca_path}", flush=True)
    print(f"根憑證 SHA-256  {ca.fingerprint(hashes.SHA256()).hex(':').upper()}", flush=True)
    return ca_path, ["--bind", "0.0.0.0", "--port", str(port),
                     "--cert", str(directory / "server.crt"), "--key", str(directory / "server.key")]


def main():
    parser = argparse.ArgumentParser(description="為桌面主機啟用區域網路 HTTPS 連線")
    parser.add_argument("address", type=ipaddress.IPv4Address, help="這台電腦在 Wi-Fi 或區域網路上的 IPv4 位址")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--state-dir", type=Path, default=PROJECT / ".remote-control")
    parser.add_argument("--request-control", action="store_true", help="在 macOS 上請求輔助使用權限")
    args = parser.parse_args()
    try:
        _, server_args = lan_server_args(args.address, args.port, args.state_dir)
    except ValueError as error:
        parser.error(str(error))
    if args.request_control:
        server_args.append("--request-control")
    return subprocess.call([sys.executable, "-m", "server", *server_args], cwd=PROJECT)


if __name__ == "__main__":
    raise SystemExit(main())
