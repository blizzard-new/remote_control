"""Launch a desktop handler with the system's libraries."""
import os
import subprocess
import sys


def open_desktop_file(path):
    env = os.environ.copy()
    if getattr(sys, "frozen", False):
        original = env.pop("LD_LIBRARY_PATH_ORIG", None)
        if original is None:
            env.pop("LD_LIBRARY_PATH", None)
        else:
            env["LD_LIBRARY_PATH"] = original
    subprocess.Popen(["xdg-open", str(path)], env=env, start_new_session=True)
