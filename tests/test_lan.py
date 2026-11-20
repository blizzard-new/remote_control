import ipaddress
import ssl
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from cryptography import x509

from scripts.start_lan import certificate_for


class LanCertificateTest(unittest.TestCase):
    def test_concurrent_launches_reuse_a_complete_identity(self):
        ip = ipaddress.IPv4Address("192.168.2.9")
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            with ThreadPoolExecutor(max_workers=4) as workers:
                targets = list(workers.map(lambda _: certificate_for(ip, state), range(4)))
            self.assertEqual(len(set(targets)), 1)
            directory = targets[0]
            self.assertEqual({p.name for p in directory.iterdir()}, {"server.key", "trusted-root.crt", "server.crt"})
            leaf = x509.load_pem_x509_certificate((directory / "server.crt").read_bytes())
            root = x509.load_pem_x509_certificate((directory / "trusted-root.crt").read_bytes())
            leaf.verify_directly_issued_by(root)
            san = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            self.assertIn(ip, san.get_values_for_type(x509.IPAddress))
            self.assertIn("localhost", san.get_values_for_type(x509.DNSName))
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(directory / "server.crt", directory / "server.key")
