import ctypes as ct
import sys
import unittest
from unittest.mock import Mock

from native.desktop import Desktop
from native.macos import ACCESS_HINT, MacBackend, Point, Quartz, Rect, _bind


class MacInputTests(unittest.TestCase):
    def setUp(self):
        self.quartz = Mock(spec=Quartz)
        # Permission checks are dynamically bound system functions.
        self.quartz.has_access = Mock(return_value=True)
        self.quartz.request_access = Mock(return_value=False)
        self.quartz.bounds.return_value = (0, 0, 1512, 982)  # Retina logical points
        self.quartz.cursor.return_value = (755.5, 490.5)
        self.host = Desktop.__new__(Desktop)
        self.host._backend = MacBackend(self.quartz)

    def test_permission_is_requested_only_on_explicit_action(self):
        self.quartz.has_access.return_value = False
        self.assertEqual(self.host.capabilities["controlHint"], ACCESS_HINT)
        self.assertFalse(self.host.capabilities["control"])
        self.quartz.request_access.assert_not_called()
        self.assertEqual(self.host.request_control(), ACCESS_HINT)
        self.quartz.request_access.assert_called_once_with()
        self.quartz.has_access.return_value = True
        self.assertTrue(self.host.capabilities["control"])
        self.assertFalse(self.host.capabilities["privacy"])
        self.assertNotIn("controlHint", self.host.capabilities)

    def test_right_button_drag_uses_quartz_points(self):
        self.host.apply({"kind": "button", "x": 0, "y": 0.5, "button": 2, "down": True})
        self.host.apply({"kind": "move", "x": 1, "y": 1})
        self.host.release()
        self.assertEqual([c.args for c in self.quartz.mouse.call_args_list], [
            (3, (0, 490.5), 1, 0, 1), (7, (1511, 981), 1, 0, 1), (4, (755.5, 490.5), 1, 0, 1),
        ])

    def test_meta_applies_to_chords_and_survives_one_side_releasing(self):
        flag = 1 << 20
        for code, down in (("MetaLeft", True), ("MetaRight", True), ("MetaLeft", False),
                           ("KeyC", True), ("KeyC", True), ("KeyC", False)):
            self.host.apply({"kind": "key", "code": code, "down": down})
        self.host.release()
        self.host.release()
        self.assertEqual([c.args for c in self.quartz.key.call_args_list], [
            (0x37, True, flag, flag, False), (0x36, True, flag, flag, False),
            (0x37, False, flag, flag, False), (0x08, True, flag, 0, False),
            (0x08, True, flag, 0, True), (0x08, False, flag, 0, False), (0x36, False, 0, flag, False),
        ])

    def test_two_axis_subpixel_scroll_and_release(self):
        for _ in range(4):
            self.host.apply({"kind": "wheel", "dx": -0.25, "dy": 0.5, "x": 0.5, "y": 0.5})
        self.assertEqual([c.args[:2] for c in self.quartz.scroll.call_args_list], [(0, 1), (-1, 1)])
        self.host.apply({"kind": "wheel", "dx": 0.9, "dy": 0.9})
        self.host.release()
        self.host.apply({"kind": "wheel", "dx": 0.2, "dy": 0.2})
        self.assertEqual(self.quartz.scroll.call_count, 2)

    def test_display_change_releases_input(self):
        self.host.apply({"kind": "key", "code": "ShiftRight", "down": True})
        self.quartz.bounds.side_effect = RuntimeError("Mac 的遠端操作需要單一啟用中的顯示器。")
        with self.assertRaises(RuntimeError):
            self.host.apply({"kind": "move", "x": 1, "y": 1})
        self.quartz.key.assert_called_with(0x3C, False, 0, 1 << 17, False)
        self.quartz.mouse.assert_not_called()

    def test_scroll_posts_pixel_units_with_quartz_axis_order(self):
        native = Quartz.__new__(Quartz)
        native._emit, native._wheel = Mock(), Mock(return_value=42)
        native.scroll(-3, 9, (10, 10), 0)
        native._wheel.assert_called_once_with(None, 0, 2, -9, 3, 0)
        native._emit.assert_called_once_with(42, 0, position=(10, 10))

    @unittest.skipUnless(sys.platform == "darwin", "macOS CoreGraphics ABI")
    def test_installed_framework_constructs_events_without_posting(self):
        quartz = Quartz()
        self.assertIsInstance(quartz.has_access(), bool)
        self.assertEqual((ct.sizeof(Point), ct.sizeof(Rect)), (16, 32))
        cg = ct.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        event_type = _bind(cg, "CGEventGetType", ct.c_uint32, ct.c_void_p)
        evt = quartz._wheel(None, 0, 2, -7, 3, 0)
        self.assertTrue(evt)
        try:
            self.assertEqual(event_type(evt), 22)  # kCGEventScrollWheel
            quartz._set_location(evt, Point(25.5, 32.0))
            point = quartz._location(evt)
            self.assertEqual((point.x, point.y), (25.5, 32.0))
        finally:
            quartz._release(evt)
