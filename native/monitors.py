"""Common desktop coordinates for screen capture and pointer input."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Monitor:
    id: str
    bounds: tuple[int, int, int, int]
    primary: bool = False

    @property
    def size(self):
        left, top, right, bottom = self.bounds
        return right - left, bottom - top

    def position(self, x, y):
        left, top, _, _ = self.bounds
        width, height = self.size
        return left + round(x * (width - 1)), top + round(y * (height - 1))
