#!/usr/bin/env python3
"""A standard-library AOTUI App that opens and edits files in a Host-selected directory."""

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path
from stat import S_ISREG
import sys


PROTOCOL = "aotui-app"
MAJOR = 2
TEXT = {"type": "string"}


def tool(view_type, name, description, properties):
    return {"viewType": view_type, "name": name, "description": description,
            "multiplicity": "single" if view_type == "directory" else "multiple",
            "inputSchema": {"type": "object", "properties": properties, "required": list(properties),
                            "additionalProperties": False}}


TOOLS = [
    tool("directory", "open_file", "Open a file by its name in the directory.", {"name": TEXT}),
    tool("directory", "reload_a", "Read A.txt again.", {}),
    tool("directory", "disable_a", "Make A.txt read-only and restrict its Ref to its own page.", {}),
    tool("file", "edit", "Write exact text to the selected file.", {"text": TEXT}),
    tool("file", "inspect_text", "Report the selected text value.", {"text": TEXT}),
]


class Connection:
    def __init__(self, stdin=None, stdout=None):
        self.stdin = sys.stdin.buffer if stdin is None else stdin
        self.stdout = sys.stdout.buffer if stdout is None else stdout
        self.interleaved = None
        self.publication_feedback = None

    def send(self, message):
        wire = json.dumps(message, ensure_ascii=False, allow_nan=False) + "\n"
        self.stdout.write(wire.encode("utf-8"))
        self.stdout.flush()

    def read(self):
        line = self.stdin.readline()
        return json.loads(line) if line else None

    def next_request(self):
        return self.read()

    def published(self, publication_id):
        while (message := self.read()) is not None:
            if message.get("type") == "publishResult" and message.get("id") == publication_id:
                return message
            if message.get("type") == "publishResult":
                if self.publication_feedback:
                    self.publication_feedback(message)
            elif self.interleaved:
                self.interleaved(message)
            else:
                raise EOFError("No active request owns interleaved input")
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


class FileUnavailable(Exception):
    pass


def is_file_name(name):
    if name in ("", ".", "..") or name.lower() == "writes.jsonl" or any(c in name for c in ("/", "\\", "\x00")):
        return False
    try:
        name.encode("utf-8")
    except UnicodeError:
        return False
    return True


class FilesApp:
    def __init__(self, connection, request):
        self.connection = connection
        self.app_id = request["appId"]
        self.instance_id = request["instanceId"]
        self.tools_enabled = request["toolsEnabled"]
        self.capabilities = request["capabilities"]
        folder = request.get("config", {}).get("folder")
        if not isinstance(folder, str) or not folder:
            raise ValueError("Set config.folder to the directory to open.")
        self.folder = Path(folder)
        self.files = {}
        self.mounts = 0
        self.publications = 0
        self.publication_attempts = 0
        self.epoch = 0
        self.healthy_since = 0
        self.activation_counter = 0
        self.active_bindings = {}
        self.ref_continuity = {}
        self.publication = None
        self.fault = None
        self.a_writable = True
        self.stopping = False
        self.sampling_request = None
        self.declaration_attempt = None
        self.declaration_sent = False

    def edit_enabled(self, page):
        return page.name != 'A.txt' or self.a_writable

    def bindings(self, page):
        mount = page.mount if page is not None else "m:1"
        return self.active_bindings.get(mount, {})

    def scope(self, page):
        return "private" if page.name == "A.txt" and not self.a_writable else "public"

    def frame(self, files):
        epoch = self.epoch + 1
        healthy_since = self.healthy_since if self.fault is None and self.healthy_since else epoch
        previous = self.active_bindings if self.fault is None else {}
        old_refs = self.ref_continuity if self.fault is None else {}
        next_bindings, next_refs = {}, {}
        counter = self.activation_counter

        def view(id_, type_, name, region, body, mount, page=None):
            nonlocal counter
            names = ["open_file", "reload_a", "disable_a"] if page is None else ["inspect_text", "close"]
            if page is not None and self.edit_enabled(page):
                names.append("edit")
            active = {}
            for action in names:
                value = previous.get(mount, {}).get(action)
                if value is None:
                    counter += 1
                    value = f"a:{counter}"
                active[action] = value
            next_bindings[mount] = active
            result = {"id": id_, "type": type_, "name": name, "region": region, "body": body, "viewInstanceId": mount,
                      "tools": [{"name": name, "activationId": key} for name, key in active.items() if name != "close"]}
            if page is not None:
                result["closeActivationId"] = active["close"]
            return result

        with os.scandir(self.folder) as entries:
            names = sorted(entry.name for entry in entries if is_file_name(entry.name) and entry.is_file(follow_symlinks=False))
        directory = f"Files: {', '.join(names) or 'none'}\nOpen files: {', '.join(files) or 'none'}"
        views = [view("directory", "directory", "directory", "static", directory, "m:1")]
        refs = []
        for page in files.values():
            scope = self.scope(page)
            body = f"{page.name}\n{page.text}\n[Content]({scope} content: string)"
            views.append(view(page.view_id, "file", page.name, "dynamic", body, page.mount, page))
            old = old_refs.get(page.mount, [0, 0, 0])
            allowed = [True, scope != "private", scope == "public"]
            witness = [old[i] or epoch if allowed[i] else 0 for i in range(3)]
            next_refs[page.mount] = witness
            refs.append({"viewId": page.view_id, "viewInstanceId": page.mount, "id": "content",
                         "scope": scope, "continuity": witness, "refType": "string", "valueSchema": TEXT, "value": page.text})
        active = {(page["type"], entry["name"]) for page in views for entry in page["tools"]}
        frame = {"producerSeq": self.publications + 1, "sourceEpoch": epoch, "healthySince": healthy_since,
                 "views": views, "refs": refs, "tools": [decl for decl in TOOLS if (decl["viewType"], decl["name"]) in active]}
        return frame, next_bindings, next_refs, counter

    def publish(self, files, opening=False):
        if self.stopping or opening and self.fault is not None:
            return {"status": "rejected", "issue": {"code": "APP_STOPPED" if self.stopping else "SNAPSHOT_UNAVAILABLE", "message": "Cannot commit this candidate."}}
        try:
            frame, bindings, refs, counter = self.frame(files)
        except OSError:
            issue = {"code": "SNAPSHOT_INVALID", "message": "Could not list the configured directory."}
            if not opening:
                self.publications += 1
                self.fault = issue
                self.connection.send({"type": "projectionFailed", "producerSeq": self.publications, "sourceEpoch": self.epoch, "issue": issue,
                                      **({"requestId": self.sampling_request} if self.sampling_request else {})})
            return {"status": "rejected", "issue": issue}
        stamp = {"appId": self.app_id, "instanceId": self.instance_id, "producerSeq": frame["producerSeq"], "sourceEpoch": frame["sourceEpoch"]}
        self.publication_attempts += 1
        id_ = "frame-" + str(self.publication_attempts)

        def commit():
            self.files = files
            self.epoch = frame["sourceEpoch"]
            self.publications = frame["producerSeq"]
            self.healthy_since = frame["healthySince"]
            self.active_bindings, self.ref_continuity, self.activation_counter = bindings, refs, counter
            self.publication = stamp
            self.fault = None

        if not opening:
            commit()
        packet = {"type": "publish", "id": id_, "mode": "candidate" if opening else "authoritative", "frame": frame}
        if self.sampling_request:
            packet["requestId"] = self.sampling_request
        if not self.declaration_sent:
            packet["viewTypes"] = [{"name": "directory", "multiplicity": "single"}, {"name": "file", "multiplicity": "multiple"}]
            self.declaration_attempt = id_
            # Unknown delivery is not a rejection. Never send a second table
            # merely because a success ACK is absent (authoritative has none).
            self.declaration_sent = True
        self.connection.send(packet)
        if opening:
            result = self.connection.published(id_)
            if result["status"] != "accepted":
                self.publication_feedback(result)
                return result
            if result.get("publication") != stamp:
                raise EOFError("Mismatched publication confirmation")
            if self.declaration_attempt == id_:
                self.declaration_attempt = None
            if self.stopping or self.fault is not None:
                return {"status": "rejected", "issue": {"code": "APP_STOPPED" if self.stopping else "SNAPSHOT_UNAVAILABLE", "message": "Candidate invalidated while awaiting confirmation."}}
            commit()
        return {"status": "accepted", "publication": stamp}

    def publication_feedback(self, packet):
        if packet.get("id") == self.declaration_attempt and packet.get("status") == "rejected":
            self.declaration_sent = False
            self.declaration_attempt = None

    def request_attention(self):
        if "attention" in self.capabilities:
            self.connection.send({"type": "attention"})

    def refresh(self):
        pass

    def open_regular_file(self, name, mode):
        unavailable = f"{name!r} is not an available regular file in this directory."
        if not is_file_name(name):
            raise FileUnavailable("Select a regular file by its exact name in the directory.")

        def opener(path, flags):
            # Require the exact disk entry, even on filesystems that accept name aliases.
            with os.scandir(self.folder) as entries:
                entry = next((entry for entry in entries if entry.name == name), None)
                if entry is None or not entry.is_file(follow_symlinks=False):
                    raise FileUnavailable(unavailable)
                listed = entry.stat(follow_symlinks=False)
            fd = os.open(path, flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            try:
                opened = os.fstat(fd)
                if not S_ISREG(opened.st_mode) or not os.path.samestat(listed, opened):
                    raise FileUnavailable(unavailable)
            except BaseException:
                os.close(fd)
                raise
            return fd

        try:
            return open(self.folder / name, mode, opener=opener)
        except OSError as failure:
            raise FileUnavailable(unavailable) from failure

    def read_file(self, name):
        try:
            with self.open_regular_file(name, "rb") as handle:
                return handle.read().decode("utf-8")
        except (OSError, UnicodeError) as failure:
            raise FileUnavailable(f"Could not read {name!r} as UTF-8.") from failure

    def write_file(self, name, text):
        with self.open_regular_file(name, "r+b") as handle:
            handle.write(text.encode("utf-8"))
            handle.truncate()

    def open_file(self, name):
        if name in self.files:
            with self.open_regular_file(name, "rb"):
                return {"success": True, "data": {"view_id": self.files[name].view_id}}
        next_mount = self.mounts + 1
        page = FilePage(name, f"doc_{next_mount}", f"m:{next_mount + 1}", self.read_file(name))
        projected = self.publish({**self.files, name: page}, opening=True)
        if projected["status"] != "accepted":
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
        if self.stopping or self.fault is not None or not self.tools_enabled:
            return refuse("TOOL_EXECUTION_UNAVAILABLE", "This App is not accepting Tools.")
        receiver, route, inputs = (request.get(field) for field in ("receiver", "tool", "input"))
        if not all(isinstance(value, dict) for value in (receiver, route, inputs)):
            return refuse("E_INVALID_ARGS", "Expected a receiving View, a Tool and business parameters.")
        view_id, mount = receiver.get("viewId"), receiver.get("viewInstanceId")
        page = self.page(view_id)
        directory = view_id == "directory" and mount == "m:1"
        if not directory and (page is None or page.mount != mount):
            return refuse("VIEW_INSTANCE_REVOKED", "The receiving file page closed or was replaced.")
        name = route.get("name")
        active = self.bindings(page)
        if (not isinstance(name, str) or route.get("viewType") != ("directory" if directory else "file")
                or name == "close" or name not in active or active[name] != receiver.get("activationId")):
            return refuse("TOOL_SOURCE_STALE", "This Tool activation is no longer current.")
        declared = next(item["inputSchema"] for item in TOOLS if item["name"] == name)
        if set(inputs) != set(declared["required"]) or any(not isinstance(item, str) for item in inputs.values()):
            return refuse("E_INVALID_ARGS", "The final business parameters do not match the Tool Schema.")
        if (failure := self.check_refs(request.get("localRefs"), inputs, mount)) is not None:
            return failure
        try:
            return {"phase": "entered-returned", "result": self.perform(name, page, inputs)}
        except FileUnavailable as failure:
            return {"phase": "entered-returned", "result": error("FILE_UNAVAILABLE", str(failure))}
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
            lane = 0 if page.mount == receiver_mount else 1
            since = source.get("since")
            if (source.get("refId") != "content" or type(since) is not int or since <= 0
                    or self.ref_continuity.get(page.mount, [0, 0, 0])[lane] != since):
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
            try:
                self.write_file(page.name, inputs["text"])
            except UnicodeEncodeError:
                return error("E_INVALID_ARGS", "The text must be valid UTF-8.", '$["text"]')
            self.files = {**self.files, page.name: replace(page, text=inputs["text"])}
            result = self.publish(self.files)
            if result["status"] != "accepted":
                return {"success": True, "data": {"saved": True, "projection": result["issue"]["code"]}}
        if result["status"] != "accepted":
            return error(result["issue"]["code"], result["issue"]["message"])
        return {"success": True}

    def close_view(self, request):
        if not self.owns_request(request):
            return refuse("APP_INSTANCE_MISMATCH", "The request belongs to another App instance.")
        if self.stopping or self.fault is not None or not self.tools_enabled:
            return refuse("VIEW_CLOSE_UNAVAILABLE", "This App is not accepting View closes.")
        page = self.page(request.get("viewId"))
        if page is None or page.mount != request.get("viewInstanceId"):
            return refuse("VIEW_INSTANCE_REVOKED", "The receiving file page closed or was replaced.")
        if self.bindings(page).get("close") != request.get("closeActivationId"):
            return refuse("VIEW_CLOSE_SOURCE_STALE", "The close activation is no longer current.")
        files = self.files.copy()
        del files[page.name]
        result = self.publish(files)
        outcome = {"success": True} if result["status"] == "accepted" else error(result["issue"]["code"], result["issue"]["message"])
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
    # The reference App opens files only within scoped operations; constructing
    # it does not own a live file handle. Failed initialization still participates
    # in the original STOP/CLOSE handshake, rather than inventing ready.
    app = None
    try:
        app = app_type(peer, request)
    except ValueError as failure:
        reply(request["id"], "failed", issue={"code": "APP_CONFIG_INVALID", "message": str(failure), "path": "$.config.folder"})
    else:
        reply(request["id"], "ready")
        peer.publication_feedback = app.publication_feedback

    active = False
    stopped = False
    finished = False
    deferred_close = None

    def dispatch(request, interleaved=False):
        nonlocal active, stopped, finished, deferred_close
        kind = request.get("type")
        if kind == "publishResult":
            if app:
                app.publication_feedback(request)
            return
        id_ = request.get("id")
        if not isinstance(id_, str):
            return
        if kind == "stop":
            stopped = True
            if app:
                app.stopping = True
            reply(id_, "done", cleanup={"state": "stopped", "issues": []})
            return
        if kind == "close":
            stopped = True
            if app:
                app.stopping = True
            if active:
                if deferred_close is None:
                    deferred_close = id_
                return
            reply(id_, "done", cleanup={"state": "completed", "issues": []})
            finished = True
            return
        if kind in ("open", "observe") and (stopped or app is None):
            reply(id_, "failed", issue={"code": "APP_STOPPED", "message": "App has no usable projection"})
            return
        if kind in ("invoke", "closeView") and (active or stopped or app is None):
            terminal = refuse("TOOL_EXECUTION_UNAVAILABLE" if kind == "invoke" else "VIEW_CLOSE_UNAVAILABLE",
                              "App has no available business slot")
            reply(id_, "tool", appId=request.get("appId"), instanceId=request.get("instanceId"), terminal=terminal)
            return
        if interleaved and kind in ("open", "observe"):
            # Sample the *old committed* publication, never the candidate
            # waiting for its ACK. A different full commit is not safe here.
            if kind == "observe" and app.fault is None and app.publication and request.get("known") == app.publication:
                peer.send({"type": "projectionCurrent", "id": id_, "publication": app.publication})
            else:
                reply(id_, "failed", issue={"code": "SNAPSHOT_UNAVAILABLE", "message": "A candidate is awaiting confirmation"})
            return
        if app is None:
            return
        active = True
        try:
            if kind == "open":
                app.sampling_request = id_
                result = app.publish(app.files)
                if result["status"] == "accepted" and not stopped:
                    reply(id_, "done", publication=app.publication)
                else:
                    reply(id_, "failed", issue=result.get("issue") or {"code": "APP_STOPPED", "message": "OPEN was stopped"})
            elif kind == "observe":
                app.sampling_request = id_
                before = app.publication
                app.refresh()
                if app.fault is None and app.publication == before and request.get("known") == app.publication and app.publication is not None and not stopped:
                    peer.send({"type": "projectionCurrent", "id": id_, "publication": app.publication})
                    return
                if app.fault is None and app.publication == before and not stopped:
                    app.publish(app.files)
                if app.fault is None and app.publication is not None and not stopped:
                    reply(id_, "done", publication=app.publication)
                else:
                    reply(id_, "failed", issue=app.fault or {"code": "SNAPSHOT_UNAVAILABLE", "message": "No healthy Frame"})
            elif kind in ("invoke", "closeView"):
                terminal = app.invoke(request) if kind == "invoke" else app.close_view(request)
                reply(id_, "tool", appId=app.app_id, instanceId=app.instance_id, terminal=terminal)
        finally:
            app.sampling_request = None
            active = False
            if deferred_close is not None:
                original, deferred_close = deferred_close, None
                dispatch({"type": "close", "id": original})

    peer.interleaved = lambda request: dispatch(request, True)
    while not finished and (request := peer.next_request()) is not None:
        dispatch(request)


if __name__ == "__main__":
    run()
