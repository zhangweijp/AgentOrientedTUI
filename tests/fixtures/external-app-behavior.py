"""Drive failures in the frozen example using only fixture-owned files and processes."""

import importlib.util
import json
import os
from pathlib import Path
import sys
from threading import Thread
from time import monotonic, sleep


source, vectors_path, scenario = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("reference_files", source)
files = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = files
spec.loader.exec_module(files)
vectors = json.loads(Path(vectors_path).read_text(encoding="utf-8"))


def wait_for(path):
    deadline = monotonic() + 12
    while not path.exists():
        if monotonic() > deadline:
            os._exit(74)
        sleep(.01)


def append(folder, name, value):
    with (folder / (name + ".jsonl")).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")


class ProbeConnection(files.Connection):
    edit_id = None
    folder = None

    def send(self, message):
        if message.get("id") == self.edit_id and message.get("status") == "tool":
            if scenario == "hold-receipt":
                (self.folder / "withholding").touch()
                wait_for(self.folder / "release")
            elif scenario == "stdout-ended-live":
                self.stdout.flush()
                os.close(1)
                (self.folder / "stdout-closed").touch()
                wait_for(self.folder / "release")
                os._exit(23)
            elif scenario == "exit-tail":
                message["terminal"]["result"]["data"] = {"text": vectors["text"] * 1000}
                wire = json.dumps(message, ensure_ascii=False).encode("utf-8")
                split = wire.index("🙂".encode("utf-8")) + 1
                self.stdout.write(wire[:split])
                self.stdout.flush()
                sleep(.03)
                self.stdout.write(wire[split:])
                self.stdout.flush()
                os._exit(0)
        super().send(message)


class ProbeApp(files.FilesApp):
    def __init__(self, connection, request):
        super().__init__(connection, request)
        self.connection.folder = self.folder
        self.disable_b_edit = False
        append(self.folder, "launches", {"pid": os.getpid(), "instanceId": self.instance_id,
                                         "capabilities": self.capabilities, "argv": sys.argv})
        if scenario == "optional-attention" and "attention" in self.capabilities:
            Thread(target=self.notify, daemon=True).start()

    def notify(self):
        wait_for(self.folder / "attention")
        self.request_attention()

    def bindings(self, page):
        active = super().bindings(page)
        if page and page.name == "B.txt" and self.disable_b_edit:
            active.pop("edit", None)
        return active

    def change(self, trigger):
        signal = self.folder / trigger
        if not signal.exists():
            return
        change = signal.read_text(encoding="utf-8")
        signal.unlink()
        if change == "mount":
            page = self.files["B.txt"]
            self.mounts += 1
            self.publish({**self.files, "B.txt": files.replace(page, mount=f"重开:{self.mounts}")}, opening=True)
        elif change == "scope":
            self.a_writable = False
            self.publish(self.files)
        elif change == "activation":
            self.disable_b_edit = True
            self.publish(self.files)

    def refresh(self):
        self.change("change-at-refresh")

    def invoke(self, request):
        if request["tool"]["name"] == "edit":
            self.connection.edit_id = request["id"]
            append(self.folder, "dispatches", {k: request[k] for k in ("id", "tool", "receiver", "input", "localRefs")})
            self.change("change-at-invoke")
            if scenario == "bad-final-input":
                request["input"]["text"] = 17
        return super().invoke(request)

    def write_file(self, name, text):
        append(self.folder, "entries", {"name": name})
        if scenario == "prewrite-exit":
            os._exit(23)
        super().write_file(name, text)
        append(self.folder, "writes", {"name": name, "text": text})
        if scenario == "postwrite-exit":
            os._exit(23)


files.run(ProbeApp, ProbeConnection(), major=vectors["incompatibleMajor"] if scenario == "wrong-major" else vectors["hello"]["major"],
          protocol="aotui-stdio" if scenario == "wrong-identity" else vectors["hello"]["protocol"],
          capabilities=("attention", vectors["unknownOptional"]),
          requires=(vectors["unknownRequired"],) if scenario == "missing-capability" else ())
