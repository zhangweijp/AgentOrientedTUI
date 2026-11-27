"""Drive a real Receiver-only failure through the production reference Producer."""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("reference_files", sys.argv[1])
files = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = files
spec.loader.exec_module(files)

class Connection(files.Connection):
    folder = None

    def send(self, packet):
        if self.folder is not None:
            with (self.folder / "wire.jsonl").open("a") as out:
                out.write(json.dumps(packet) + "\n")
        super().send(packet)

class App(files.FilesApp):
    def __init__(self, connection, request):
        super().__init__(connection, request)
        connection.folder = self.folder

    def refresh(self):
        e2, e3 = self.folder / "e2", self.folder / "e3"
        if e2.exists():
            e2.unlink()
            # Commit locally, with 4 views against the effective Receiver limit 3.
            self.a_writable = False
            self.mounts += 1
            extra = files.FilePage("C.txt", f"doc_{self.mounts}", f"m:{self.mounts + 1}", "extra")
            self.publish({**self.files, "C.txt": extra})
        elif e3.exists():
            e3.unlink()
            self.a_writable = True
            self.publish({name: page for name, page in self.files.items() if name != "C.txt"}, opening=True)

    def invoke(self, request):
        with (self.folder / "requests.jsonl").open("a") as out:
            out.write(json.dumps(request) + "\n")
        return super().invoke(request)

files.run(App, Connection())
