import hashlib
from io import BytesIO
from unittest import TestCase, mock

from native.updates import DesktopUpdates, release_info, Release


class UpdateTests(TestCase):
    name = "RemoteControl-macOS-arm64.pkg"
    tag = "v0.10.0"

    def setUp(self):
        payload = b"installer"
        self.sha = hashlib.sha256(payload).hexdigest()
        self.url = f"https://github.com/blizzard-new/remote_control/releases/download/{self.tag}/{self.name}"
        self.metadata = dict(tag_name=self.tag, assets=[dict(name=self.name, browser_download_url=self.url,
                             digest="sha256:" + self.sha, size=len(payload), state="uploaded")])

    def test_choose_exact_asset_and_compare_versions(self):
        offer = release_info(self.metadata, self.name, "0.9.1")
        self.assertEqual(offer, Release("0.10.0", self.url, self.sha, 9))
        self.assertFalse(release_info(self.metadata, self.name, "1.0.0").url)
        for name, value in (("name","RemoteControl-Windows-x64.exe"), ("browser_download_url", "https://example.com/app"),
                            ("digest","sha256:bad"), ("state","new"), ("size",0)):
            with self.subTest(name=name):
                bad = {**self.metadata, "assets": [{**self.metadata["assets"][0], name: value}]}
                with self.assertRaises(ValueError):
                    release_info(bad, self.name)

    def test_download_verifies_bytes_before_opening_installer(self):
        check = DesktopUpdates(self.name)
        offer = release_info(self.metadata, self.name)
        for data in [b"changed!!", b"short", b"much longer than expected"]:
            with mock.patch("native.updates.fetch", return_value=BytesIO(data)), self.assertRaises(ValueError):
                check.download(offer)
        with mock.patch("native.updates.fetch", return_value=BytesIO(b"installer")):
            path = check.download(offer)
            try:
                self.assertEqual(path.name,self.name)
                self.assertEqual(path.read_bytes(),b"installer")
            finally:
                path.unlink()
                path.parent.rmdir()
