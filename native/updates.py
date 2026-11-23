"""Update the installed desktop client from this project's stable GitHub releases."""
import asyncio
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import ssl
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPSHandler, HTTPRedirectHandler, Request

import certifi

VERSION = "0.5.4"
REPOSITORY = "blizzard-new/remote_control"
LATEST = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
MAX_SIZE = 160 * 1024 * 1024


def asset_name():
    if sys.platform == "win32":
        return "RemoteControl-Setup-Windows-x64.exe"
    if sys.platform == "darwin" and platform.machine() in {"arm64", "x86_64"}:
        return f"RemoteControl-macOS-{platform.machine()}.pkg"
    return None


class GitHubRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urlsplit(newurl)
        if url.scheme != "https" or url.netloc not in {
            "github.com", "api.github.com", "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
        }:
            raise ValueError("更新下載位置無效。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url):
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    client = build_opener(HTTPSHandler(context=context), GitHubRedirect())
    return client.open(Request(url, headers={"User-Agent": "Uniway-RemoteControl/" + VERSION}), timeout=30)


@dataclass(frozen=True)
class Release:
    version: str
    url: str = ""
    digest: str = ""
    size: int = 0


def release_info(metadata, name, current=VERSION):
    tag = metadata["tag_name"]
    if metadata.get("draft") or metadata.get("prerelease") or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("無法辨識正式版版本。")
    version = tag[1:]
    if tuple(map(int, version.split("."))) <= tuple(map(int, current.split("."))):
        return Release(version)
    url = f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}"
    for asset in metadata["assets"]:
        digest = asset.get("digest") or ""
        if (asset["name"] == name and asset["browser_download_url"] == url and asset.get("state") == "uploaded"
                and re.fullmatch(r"sha256:[0-9a-f]{64}", digest) and 0 < asset["size"] <= MAX_SIZE):
            return Release(version, url, digest[7:], asset["size"])
    raise ValueError("此平台的新版安裝檔尚未就緒，請稍後再試。")


class DesktopUpdates:
    def __init__(self, name):
        self.name = name
        self.lock = asyncio.Lock()
        self.offer = None

    def check(self):
        with fetch(LATEST) as response:
            return release_info(json.loads(response.read(2**20)), self.name)

    def download(self, offer):
        directory = Path(tempfile.mkdtemp(prefix="RemoteControl-update-"))
        path = directory / self.name
        try:
            digest = hashlib.sha256()
            total = 0
            with fetch(offer.url) as stream, path.open("xb") as output:
                while chunk := stream.read(256 * 1024):
                    total += len(chunk)
                    if total > offer.size:
                        raise ValueError("更新大小不符。")
                    output.write(chunk)
                    digest.update(chunk)
            if total != offer.size or digest.hexdigest() != offer.digest:
                raise ValueError("更新檔驗證失敗，請重新檢查更新。")
            return path
        except BaseException:
            path.unlink(missing_ok=True)
            directory.rmdir()
            raise

    async def run(self, action, busy):
        if self.lock.locked():
            raise ValueError("正在處理更新。")
        async with self.lock:
            if action == "check":
                self.offer = None
                self.offer = await asyncio.to_thread(self.check)
                return dict(current=VERSION, latest=self.offer.version, available=bool(self.offer.url))
            if action != "install" or not self.offer or not self.offer.url:
                raise ValueError("請先檢查更新。")
            if busy():
                raise ValueError("請先結束遠端連線，再安裝更新。")
            path = await asyncio.to_thread(self.download, self.offer)
            if busy():
                path.unlink()
                path.parent.rmdir()
                raise ValueError("請先結束遠端連線，再安裝更新。")
            if sys.platform == "win32":
                os.startfile(str(path))
            else:
                subprocess.Popen(["/usr/bin/open", "-a", "Installer", str(path)])
            self.offer = None
            return dict(installing=True)
