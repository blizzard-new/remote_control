from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from server.pairings import update

class PairGrantTests(unittest.TestCase):
    def test_legacy_pair_and_reverse_direction_require_local_grant(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "db"
            item = dict(listen="A"*32,dial="B"*32,name="tablet",address="https://relay.example")
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("CREATE TABLE devices(listen TEXT PRIMARY KEY,dial TEXT,name TEXT,address TEXT)")
                db.execute("INSERT INTO devices VALUES(?,?,?,?)",tuple(item.values()))
            self.assertEqual(update(path,"list",{})[0]["grant"],"")
            self.assertEqual(update(path,"save",{**item,"grant":"view"})[0]["grant"],"view")
            with self.assertRaises(ValueError):
                update(path,"save",{**item,"grant":"admin"})
            self.assertEqual(update(path,"forget",item),[])
            self.assertEqual(update(path,"save",item)[0]["grant"],"")

    def test_refresh_identity_preserves_permissions_and_cannot_restore_forgotten_record(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "db"
            old = dict(listen="A"*32, dial="B"*32, name="我的電腦", address="https://relay.example", grant="view")
            update(path, "save", old)
            new = {**old, "name": "書房電腦", "platform": "Windows", "grant": "control"}
            self.assertEqual(update(path, "identify", new), [{**new, "grant": "view"}])
            with self.assertRaises(ValueError):
                update(path, "identify", {**new, "dial": "C"*32})
            update(path, "forget", old)
            with self.assertRaises(ValueError):
                update(path, "identify", new)
            self.assertEqual(update(path, "list", {}), [])
