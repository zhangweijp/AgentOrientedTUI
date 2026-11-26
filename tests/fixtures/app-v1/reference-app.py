#!/usr/bin/env python3
"""A standard-library AOTUI App that opens and edits A.txt and B.txt."""

import json
from collections import deque
from dataclasses import dataclass, replace
from pathlib import Path
import sys


PROTOCOL = "aotui-app"
MAJOR = 1
NAMES = ("A.txt", "B.txt")
TEXT = {"type": "string"}


def tool(view_type, name, description, properties):
    return {"viewType": view_type, "name": name, "description": description,
            "multiplicity": "single" if view_type == "directory" else "multiple",
            "inputSchema": {"type": "object", "properties": properties, "required": list(properties),
                            "additionalProperties": False}}


TOOLS = [
    tool("directory", "open_file", "Open a file.", {"name": {**TEXT, "enum": list(NAMES)}}),
    tool("directory", "reload_a", "Read A.txt again.", {}),
    tool("directory", "disable_a", "Make A.txt read-only and restrict its Ref to its own page.", {}),
    tool("file", "edit", "Write exact text to the selected file.", {"text": TEXT}),
    tool("file", "inspect_text", "Report the selected text value.", {"text": TEXT}),
]


class Connection:
    def __init__(self, stdin=None, stdout=None):
        self.stdin = sys.stdin.buffer if stdin is None else stdin
        self.stdout = sys.stdout.buffer if stdout is None else stdout
        self.pending = deque()

    def send(self, message):
        wire = json.dumps(message, ensure_ascii=False, allow_nan=False) + "\n"
        self.stdout.write(wire.encode("utf-8"))
        self.stdout.flush()

    def read(self):
        line = self.stdin.readline()
        return json.loads(line) if line else None

    def next_request(self):
        return self.pending.popleft() if self.pending else self.read()

    def published(self, publication_id):
        while (message := self.read()) is not None:
            if message.get("type") == "publishResult" and message.get("id") == publication_id:
                return message
            self.pending.append(message)
        raise EOFError("Runtime closed during publication")


@dataclass(frozen=True)
class FilePage:
    name: str
    view_id: str
    mount: str
    text: str


def error(code, message, path=None):
    value = {"code": code, "message": message}
    if path is not None:
        value["context"] = {"path": path}
    return {"success": False, "error": value}


def refuse(code, message, path=None):
    return {"phase": "not-entered", "result": error(code, message, path)}


class FilesApp:
    def __init__(self, connection, request):
        self.connection = connection
        self.app_id = request["appId"]
        self.instance_id = request["instanceId"]
        self.tools_enabled = request["toolsEnabled"]
        self.capabilities = request["capabilities"]
        folder = request["config"].get("folder")
        if not isinstance(folder, str) or not folder:
            raise ValueError("Set config.folder to a directory containing A.txt and B.txt.")
        self.folder = Path(folder)
        self.files = {}
        self.mounts = 0
        self.publications = 0
        self.a_writable = True
        self.stopping = False

    def bindings(self, page):
        if page is None:
            return {name: "workspace:" + name for name in ("open_file", "reload_a", "disable_a")}
        active = {"inspect_text": page.mount + ":inspect_text"}
        if page.name != "A.txt" or self.a_writable:
            active["edit"] = page.mount + ":edit"
        return active

    def scope(self, page):
        return "private" if page.name == "A.txt" and not self.a_writable else "public"

    def frame(self, files):
        def view(id_, type_, name, region, body, mount, page=None):
            result = {"id": id_, "type": type_, "name": name, "region": region, "body": body, "viewInstanceId": mount,
                      "tools": [{"name": name, "activationId": key} for name, key in self.bindings(page).items()]}
            if page is not None:
                result["canClose"] = True
            return result

        views = [view("directory", "directory", "directory", "static",
                      "Files A.txt and B.txt.\nOpen files: " + (", ".join(files) or "none"), "workspace")]
        refs = []
        for page in files.values():
            scope = self.scope(page)
            body = f"{page.name}\n{page.text}\n[Content]({scope} content: string)"
            views.append(view(page.view_id, "file", page.name, "dynamic", body, page.mount, page))
            refs.append({"viewId": page.view_id, "viewInstanceId": page.mount, "id": "content",
                         "scope": scope, "refType": "string", "valueSchema": TEXT, "value": page.text})
        active = {(page["type"], entry["name"]) for page in views for entry in page["tools"]}
        return {"views": views, "refs": refs, "tools": [decl for decl in TOOLS if (decl["viewType"], decl["name"]) in active]}

    def publish(self, files, opening=False):
        self.publications += 1
        id_ = "frame-" + str(self.publications)
        self.connection.send({"type": "publish", "id": id_, "opening": opening, "frame": self.frame(files)})
        result = self.connection.published(id_)
        if result["status"] == "prepared":
            self.files = files
        return result

    def request_attention(self):
        if "attention" in self.capabilities:
            self.connection.send({"type": "attention"})

    def refresh(self):
        pass

    def read_file(self, name):
        return (self.folder / name).read_bytes().decode("utf-8")

    def write_file(self, name, text):
        (self.folder / name).write_bytes(text.encode("utf-8"))

    def open_file(self, name):
        if name in self.files:
            return {"success": True, "data": {"view_id": self.files[name].view_id}}
        next_mount = self.mounts + 1
        page = FilePage(name, f"doc_{next_mount}", f"file:{next_mount}", self.read_file(name))
        projected = self.publish({**self.files, name: page}, opening=True)
        if projected["status"] != "prepared":
            issue = projected["issue"]
            return error(issue["code"], issue["message"], issue.get("path"))
        self.mounts = next_mount
        return {"success": True, "data": {"view_id": page.view_id}}

    def page(self, view_id):
        return next((page for page in self.files.values() if page.view_id == view_id), None)

    def owns_request(self, request):
        return request.get("appId") == self.app_id and request.get("instanceId") == self.instance_id

    def invoke(self, request):
        if not self.owns_request(request):
            return refuse("APP_INSTANCE_MISMATCH", "The request belongs to another App instance.")
        if self.stopping or not self.tools_enabled:
            return refuse("TOOL_EXECUTION_UNAVAILABLE", "This App is not accepting Tools.")
        receiver, route, inputs = (request.get(field) for field in ("receiver", "tool", "input"))
        if not all(isinstance(value, dict) for value in (receiver, route, inputs)):
            return refuse("E_INVALID_ARGS", "Expected a receiving View, a Tool and business parameters.")
        view_id, mount = receiver.get("viewId"), receiver.get("viewInstanceId")
        page = self.page(view_id)
        directory = view_id == "directory" and mount == "workspace"
        if not directory and (page is None or page.mount != mount):
            return refuse("VIEW_INSTANCE_REVOKED", "The receiving file page closed or was replaced.")
        name = route.get("name")
        active = self.bindings(page)
        if (not isinstance(name, str) or route.get("viewType") != ("directory" if directory else "file")
                or name not in active or active[name] != receiver.get("activationId")):
            return refuse("TOOL_SOURCE_STALE", "This Tool activation is no longer current.")
        declared = next(item["inputSchema"] for item in TOOLS if item["name"] == name)
        if set(inputs) != set(declared["required"]) or any(not isinstance(item, str) for item in inputs.values()):
            return refuse("E_INVALID_ARGS", "The final business parameters do not match the Tool Schema.")
        if name == "open_file" and inputs["name"] not in NAMES:
            return refuse("E_INVALID_ARGS", "Select A.txt or B.txt.")
        if (failure := self.check_refs(request.get("localRefs"), inputs, mount)) is not None:
            return failure
        try:
            return {"phase": "entered-returned", "result": self.perform(name, page, inputs)}
        except (OSError, EOFError, UnicodeError):
            return {"phase": "finished-unknown"}

    def check_refs(self, sources, inputs, receiver_mount):
        if not isinstance(sources, list):
            return refuse("E_INVALID_ARGS", "localRefs must be an array.")
        seen = set()
        for source in sources:
            # These file Tools accept only scalar strings, so no Ref can occupy an array element.
            if (not isinstance(source, dict) or not isinstance(source.get("param"), str) or "index" in source
                    or source["param"] not in inputs or source["param"] in seen):
                return refuse("E_INVALID_ARGS", "A local Ref must identify a unique business parameter.")
            parameter = source["param"]
            seen.add(parameter)
            path = "$[" + json.dumps(parameter) + "]"
            page = self.page(source.get("viewId"))
            if page is None or page.mount != source.get("viewInstanceId"):
                return refuse("VIEW_INSTANCE_REVOKED", "The publishing file page closed or was replaced.", path)
            if source.get("refId") != "content" or (self.scope(page) == "private" and page.mount != receiver_mount):
                return refuse("REF_NOT_VISIBLE", "The publishing page no longer grants this Ref.", path)
        return None

    def perform(self, name, page, inputs):
        if name == "open_file":
            return self.open_file(inputs["name"])
        if name == "inspect_text":
            return {"success": True, "data": {"text": inputs["text"]}}
        if name == "reload_a":
            if "A.txt" not in self.files:
                return self.open_file("A.txt")
            page = self.files["A.txt"]
            result = self.publish({**self.files, page.name: replace(page, text=self.read_file(page.name))})
        elif name == "disable_a":
            self.a_writable = False
            result = self.publish(self.files)
        else:
            self.write_file(page.name, inputs["text"])
            self.files = {**self.files, page.name: replace(page, text=inputs["text"])}
            result = self.publish(self.files)
            if result["status"] != "prepared":
                return {"success": True, "data": {"saved": True, "projection": result["issue"]["code"]}}
        if result["status"] != "prepared":
            return error(result["issue"]["code"], result["issue"]["message"])
        return {"success": True}

    def close_view(self, request):
        if not self.owns_request(request):
            return refuse("APP_INSTANCE_MISMATCH", "The request belongs to another App instance.")
        if self.stopping or not self.tools_enabled:
            return refuse("VIEW_CLOSE_UNAVAILABLE", "This App is not accepting View closes.")
        page = self.page(request.get("viewId"))
        if page is None or page.mount != request.get("viewInstanceId"):
            return refuse("VIEW_INSTANCE_REVOKED", "The receiving file page closed or was replaced.")
        files = self.files.copy()
        del files[page.name]
        result = self.publish(files)
        outcome = {"success": True} if result["status"] == "prepared" else error(result["issue"]["code"], result["issue"]["message"])
        return {"phase": "entered-returned", "result": outcome}


def run(app_type=FilesApp, connection=None, protocol=PROTOCOL, major=MAJOR, capabilities=("attention",), requires=()):
    peer = connection or Connection()

    def reply(id_, status, **data):
        peer.send({"type": "reply", "id": id_, "status": status, **data})

    hello = peer.read()
    if hello is None:
        return
    peer.send({"type": "hello", "protocol": protocol, "major": major, "capabilities": capabilities, "requires": requires})
    if hello.get("type") != "hello" or hello.get("protocol") != protocol or hello.get("major") != major:
        return
    request = peer.read()
    if request is None or request.get("type") != "initialize":
        return
    try:
        app = app_type(peer, request)
    except ValueError as failure:
        return reply(request["id"], "failed", issue={"code": "APP_CONFIG_INVALID", "message": str(failure), "path": "$.config.folder"})
    reply(request["id"], "ready")

    while (request := peer.next_request()) is not None:
        id_, kind = request["id"], request["type"]
        if kind == "open":
            frame = app.publish(app.files)
            if frame["status"] == "prepared":
                reply(id_, "done")
            else:
                reply(id_, "failed", issue=frame["issue"])
        elif kind == "observe":
            app.refresh()
            reply(id_, "done")
        elif kind in ("invoke", "closeView"):
            terminal = app.invoke(request) if kind == "invoke" else app.close_view(request)
            reply(id_, "tool", appId=app.app_id, instanceId=app.instance_id, terminal=terminal)
        elif kind in ("stop", "close"):
            app.stopping = True
            reply(id_, "done", cleanup={"state": "stopped" if kind == "stop" else "completed", "issues": []})
            if kind == "close":
                return


if __name__ == "__main__":
    run()
