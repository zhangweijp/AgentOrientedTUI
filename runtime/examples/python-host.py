"""Build an Agent turn from the public AOTUI stdio protocol using only Python's standard library."""

import argparse
import json
import subprocess
import warnings
from concurrent.futures import Future
from contextlib import contextmanager
from pathlib import Path
from queue import Queue
from tempfile import TemporaryDirectory
from threading import Lock, Thread


class ProtocolError(RuntimeError):
    def __init__(self, reply):
        super().__init__(reply)
        self.reply = reply
        self.code = reply["error"]["code"]


class RuntimeClient:
    def __init__(self, executable, *, protocol="aotui-stdio", major_version=1, required=(), optional=()):
        required = tuple(required)
        self.process = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        text=True, encoding="utf-8")
        self.request_id = 0
        self.current_turn = None
        self._lock = Lock()
        self._pending = {}
        self._events = Queue()
        self._failure = None
        self._closing = False
        self._reader = Thread(target=self._read, daemon=True)
        self._reader.start()
        try:
            hello = self.call("initialize", protocol=protocol, majorVersion=major_version,
                              capabilities={"required": list(required), "optional": list(optional)})
            if hello["protocol"] != protocol or hello["majorVersion"] != major_version:
                raise RuntimeError(f"Unexpected Runtime handshake {hello!r}")
            self.capabilities = frozenset(hello["capabilities"])
            if not self.capabilities.issuperset(required):
                raise RuntimeError(f"Runtime omitted required capabilities {set(required) - self.capabilities!r}")
        except BaseException as error:
            self.__exit__(type(error), error, error.__traceback__)
            raise

    def __enter__(self):
        return self

    def __exit__(self, _exception_type, error, _traceback):
        try:
            with self._lock:
                self._closing = True
                self.process.stdin.close()
            try:
                status = self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                raise
            if status:
                raise RuntimeError(f"Runtime exited with status {status}")
        except Exception as cleanup_error:
            if error is None:
                raise
            error.add_note(f"Runtime cleanup also failed: {cleanup_error}")
        finally:
            self._reader.join()
            self.process.stdout.close()

    def call(self, method, **params):
        return self.send(method, **params).result()

    def send(self, method, **params):
        future = Future()
        future.set_running_or_notify_cancel()
        with self._lock:
            if self._failure is not None:
                raise self._failure
            if self._closing:
                raise RuntimeError("Runtime connection is closing")
            self.request_id += 1
            request_id = self.request_id
            line = json.dumps({"id": request_id, "method": method, "params": params}) + "\n"
            self._pending[request_id] = method, future
            try:
                self.process.stdin.write(line)
                self.process.stdin.flush()
            except Exception:
                self._pending.pop(request_id, None)
                raise
        return future

    def next_event(self, timeout=None):
        event = self._events.get(timeout=timeout)
        if isinstance(event, Exception):
            self._events.put(event)
            raise event
        return event

    def _read(self):
        failure = RuntimeError("Runtime connection closed")
        try:
            for line in self.process.stdout:
                reply = json.loads(line)
                if "event" in reply and "id" not in reply:
                    self._events.put(reply)
                    continue
                request_id = reply["id"]
                with self._lock:
                    if type(request_id) is not int or request_id not in self._pending:
                        raise RuntimeError(f"Unexpected Runtime reply {reply!r}")
                    method, future = self._pending[request_id]
                    if "error" not in reply:
                        result = reply["result"]
                        if method == "adoptTurn" and result["status"] == "adopted":
                            self.current_turn = result["turn"]
                        elif method in ("releaseTurn", "shutdown"):
                            self.current_turn = None
                    del self._pending[request_id]
                if "error" in reply:
                    future.set_exception(ProtocolError(reply))
                else:
                    future.set_result(result)
        except Exception as error:
            failure = error
        finally:
            with self._lock:
                self._failure = failure
                self.current_turn = None
                pending, self._pending = self._pending, {}
            for _, future in pending.values():
                future.set_exception(failure)
            self._events.put(failure)


def view_key(view):
    return view["id"], view["viewInstanceId"]


@contextmanager
def candidate_scope(client):
    scope_id = client.call("beginCandidateScope")["scopeId"]
    try:
        yield scope_id
    except BaseException as error:
        try:
            issues = client.call("discardScope", scopeId=scope_id)["cleanupIssues"]
            if issues:
                error.add_note(f"Candidate cleanup also failed: {issues}")
        except Exception as cleanup_error:
            error.add_note(f"Candidate cleanup also failed: {cleanup_error}")
        raise
    else:
        issues = client.call("discardScope", scopeId=scope_id)["cleanupIssues"]
        if issues:
            warnings.warn(f"Candidate cleanup reported: {issues}", stacklevel=2)


def prepare_turn(client, app, *, budget_hints=()):
    with candidate_scope(client) as scope_id:
        prepared = client.call("observe", app=app["app"], scopeId=scope_id)
        if prepared["status"] != "prepared":
            raise RuntimeError(prepared)
        observation = prepared["observation"]
        folded = app.setdefault("folded", {})
        mounts = {view_key(view) for view in observation["views"]}
        for key in list(folded):
            if key is not None and key not in mounts:
                del folded[key]
        views = []
        for view in observation["views"]:
            choice = {"viewInstanceId": view["viewInstanceId"], "kind": "body"}
            if view_key(view) in folded:
                choice.update(kind="collapsed", note=folded[view_key(view)])
            elif view["id"] in budget_hints:
                choice.update(kind="hint")
            views.append(choice)
        item = {"candidate": prepared["candidate"], "views": views, "collapsed": None in folded}
        if None in folded:
            item["note"] = folded[None]
        catalog = [entry["installationId"] for entry in client.call("listApps")
                   if entry.get("appInstanceId") == app["instanceId"]]
        app["installationId"] = catalog[0] if catalog else None
        plan = {"apps": [item], "catalog": catalog,
                "capabilities": ["open", "close", "collapse", "expand", "collapseView", "expandView", "closeView", "inspectRef"]}
        presented = client.call("presentTurn", scopeId=scope_id, **plan)
        if presented["issues"]:
            raise RuntimeError(presented["issues"])
        pages = [{"role": "user", "content": view["content"], "region": view["region"]} for view in presented["views"]]
        messages = [{"role": "user", "content": presented["instruction"]},
                    *[page for page in pages if page["region"] == "static"],
                    {"role": "user", "content": presented["desktop"]},
                    *[page for page in pages if page["region"] == "dynamic"]]
        adopted = client.call("adoptTurn", scopeId=scope_id, presentation=presented["presentation"])
        if adopted["status"] != "adopted":
            raise RuntimeError(adopted)
        if adopted["cleanupIssues"]:
            warnings.warn(f"Previous turn cleanup reported: {adopted['cleanupIssues']}", stacklevel=2)
        return adopted["turn"], observation, messages, presented["tools"]


def apply_window_tool(client, app, prepared, tool_name, *, app_id=None, installation_id=None, view_id=None, note=""):
    turn, observation, _, tools = prepared
    if turn != client.current_turn:
        raise RuntimeError({"error": {"code": "TURN_NOT_ACTIVE"}})
    if not any(tool["name"] == tool_name and "toolId" not in tool for tool in tools):
        raise ValueError("Choose a window action from this request.")
    if tool_name == "system-open_app":
        if not installation_id or installation_id != app.get("installationId"):
            raise ValueError("Choose an installation from this request's desktop directory.")
        return client.call("openApp", installationId=installation_id)
    if app_id != app["appId"]:
        raise ValueError("Choose a window action and App from this request.")
    if tool_name == "system-close_app":
        return client.call("closeApp", app=app["app"])
    target = {"app": app["app"], "turn": turn}
    key = None
    live = client.call("getAppWindows", app=app["app"])
    if live is None:
        raise ValueError("This App is no longer running.")
    if tool_name.endswith("_view"):
        view = next((item for item in observation["views"] if item["id"] == view_id), None)
        if view is None:
            raise ValueError("Choose a View ID from this request.")
        key = view_key(view)
        target.update(viewId=key[0], viewInstanceId=key[1])
        if not any((item["viewId"], item["viewInstanceId"]) == key for item in live["views"]):
            raise ValueError("This View has been closed or replaced.")
    folded = app["folded"]
    if key is not None and None in folded:
        raise ValueError("Expand this App before managing its Views.")
    if tool_name == "system-close_view":
        result = client.call("closeView", **target)
        if result["status"] == "closed":
            folded.pop(key, None)
        return result
    if tool_name.startswith("system-collapse_"):
        if key in folded or not isinstance(note, str):
            raise ValueError("Collapse an open window and supply a string note if needed.")
        client.call("revokeWindowAccess", **target)
        folded[key] = note
    else:
        if key not in folded:
            raise ValueError("Choose a folded window to expand.")
        del folded[key]
    return {"status": "succeeded"}


def invoke(client, app, prepared, tool_name, invocation, **args):
    turn, _, _, tools = prepared
    tool = next((item for item in tools if item["name"] == tool_name), None)
    if tool is None:
        raise ValueError("Choose a tool name from this request.")
    if tool_name == "system-inspect_ref":
        return client.call("inspectRef", turn=turn, **args)
    if "toolId" not in tool:
        raise ValueError("Choose an App tool, or use the window action handler.")
    receipt = client.call("invokeNative", turn=turn, name=tool_name, invocationId=invocation, input=args)
    if receipt["kind"] != "receipt" or receipt["receipt"]["outcome"]["status"] != "succeeded":
        raise RuntimeError(receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", default="./node_modules/.bin/aotui-stdio")
    parser.add_argument("--app", type=Path, default=Path(__file__).resolve().parent / "files")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="aotui-python-") as temp, RuntimeClient(args.bridge) as client:
        folder = Path(temp)
        for name, value in (("a.txt", "Alpha"), ("b.txt", "Bravo")):
            (folder / name).write_text(value, encoding="utf-8")
        client.call("registerApp", installationId="files", localPath=str(args.app.resolve()), config={"folder": temp})
        app = client.call("openApp", installationId="files")
        app["name"] = next(item["name"] for item in client.call("listApps") if item.get("appId") == app["appId"])
        open_file = f"{app['appId']}-open_file"
        edit = f"{app['appId']}-edit"
        first = prepare_turn(client, app)
        assert all(tool["name"] != edit for tool in first[3])
        invoke(client, app, first, open_file, "open-a", name="a.txt")
        invoke(client, app, first, open_file, "open-b", name="b.txt")
        prepared = prepare_turn(client, app)
        assert sum(tool["name"] == edit for tool in prepared[3]) == 1
        target = next(view["id"] for view in prepared[1]["views"] if view["name"] == "b.txt")
        address = f"$ref.{app['appId']}.{target}.text"
        assert invoke(client, app, prepared, "system-inspect_ref", "inspect-b", address=address, mode="value") == {"status": "ready", "value": "Bravo"}
        receipt = invoke(client, app, prepared, edit, "edit-b", view_id=target, expected=address, text="Bravo updated")
        shown = prepare_turn(client, app)
        recovered = client.call("readReceipt", app=app["app"], observationId=prepared[1]["observationId"], invocationId="edit-b")
        assert recovered == receipt
        disk = {name: (folder / name).read_text(encoding="utf-8") for name in ("a.txt", "b.txt")}
        assert disk == {"a.txt": "Alpha", "b.txt": "Bravo updated"}
        assert sum("Bravo updated" in message["content"] for message in shown[2]) == 1
        print(json.dumps({"messages": prepared[2], "tools": prepared[3], "receipt": receipt["receipt"], "files": disk}))


if __name__ == "__main__":
    main()
