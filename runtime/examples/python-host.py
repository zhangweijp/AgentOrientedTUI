"""Build an Agent turn from the public AOTUI stdio protocol using only Python's standard library."""

import argparse
import json
import re
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from xml.sax.saxutils import escape, quoteattr


class RuntimeClient:
    def __init__(self, executable):
        self.process = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        text=True, encoding="utf-8")
        self.request_id = 0
        self.current_turn = None

    def __enter__(self):
        return self

    def __exit__(self, _exception_type, error, _traceback):
        try:
            self.process.stdin.close()
            status = self.process.wait(timeout=15)
            if status:
                raise RuntimeError(f"Runtime exited with status {status}")
        except Exception as cleanup_error:
            if error is None:
                raise
            error.add_note(f"Runtime cleanup also failed: {cleanup_error}")
        finally:
            self.process.stdout.close()

    def call(self, method, **params):
        self.request_id += 1
        request_id = self.request_id
        self.process.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        reply = json.loads(self.process.stdout.readline())
        if reply["id"] != request_id or "error" in reply:
            raise RuntimeError(reply)
        result = reply["result"]
        if method == "adoptTurn" and result["status"] == "adopted":
            self.current_turn = result["turn"]
        elif method in ("releaseTurn", "shutdown"):
            self.current_turn = None
        return result


def view_key(view):
    return view["id"], view["viewInstanceId"]


def collapsed_text(note):
    return "Window collapsed." + (f"\n\nNote: {note}" if note else "")


def prepare_turn(client, app, *, budget_hints=()):
    prepared = client.call("observe", app=app["app"])
    if prepared["status"] != "prepared":
        raise RuntimeError(prepared)
    observation = prepared["observation"]
    views = observation["views"]
    folded = app.setdefault("folded", {})
    mounts = {view_key(view) for view in views}
    for key in list(folded):
        if key is not None and key not in mounts:
            del folded[key]
    expanded = [] if None in folded else [view for view in views if view_key(view) not in folded]
    complete = [view for view in expanded if view["id"] not in budget_hints]

    def identities(selected):
        return [{"viewId": view["id"], "viewInstanceId": view["viewInstanceId"]} for view in selected]

    windows = {"receiverViews": identities(expanded), "refViews": identities(complete)}
    messages = []
    if None in folded:
        content = escape(app["appId"] + " " + collapsed_text(folded[None]))
        messages.append({"role": "user", "content": f"<desktop>\n{content}\n</desktop>"})
    complete_ids = {view["id"] for view in complete}
    for view in views if None not in folded else []:
        attrs = {"view_id": view["id"], "view_type": view["type"],
                 "app_id": app["appId"], "app_name": app["name"]}
        opening = " ".join(f"{key}={quoteattr(value)}" for key, value in attrs.items())
        key = view_key(view)
        if key in folded:
            body = collapsed_text(folded[key])
        elif view["id"] not in complete_ids:
            body = "Context budget: the body is omitted. Available tools may still operate on this View."
        else:
            body = view["content"]["value"]
            refs = []
            for ref in observation["refs"]:
                if ref["viewId"] == view["id"] and ref["viewInstanceId"] == view["viewInstanceId"]:
                    ref_id = ref["refId"]
                    suffix = "." + ref_id if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", ref_id) else "[" + json.dumps(ref_id) + "]"
                    label = ref["refType"] + ("[]" if ref.get("array") else "")
                    refs.append(f"- {ref['scope']} $ref.{app['appId']}.{view['id']}{suffix} ({label})")
            if refs:
                body += "\n\nAvailable references\n" + "\n".join(refs)
        messages.append({"role": "user", "content": f"<view {opening}>\n{escape(body)}\n</view>"})
    controls = []
    if any(ref["viewId"] in complete_ids for ref in observation["refs"]):
        controls.append({"name": "system-inspect_ref", "description": "Inspect a visible Ref’s schema or its public value.",
                      "schema": {"type": "object", "required": ["address", "mode"], "additionalProperties": False,
                                 "properties": {"address": {"type": "string"}, "mode": {"type": "string", "enum": ["schema", "value"]}}}})
    actions = (
        ("system-collapse_app", "Collapse this App and optionally leave a note.", None not in folded),
        ("system-expand_app", "Expand this App on the next turn.", None in folded),
        ("system-collapse_view", "Collapse a View and optionally leave a note.", bool(expanded)),
        ("system-expand_view", "Expand a collapsed View on the next turn.",
         None not in folded and any(view_key(view) in folded for view in views)),
        ("system-close_view", "Close a View that supports independent closure.",
         None not in folded and any(view.get("canClose") for view in views)),
    )
    for name, description, available in actions:
        if not available:
            continue
        required = ["app_id"]
        if name.endswith("_view"):
            required.append("view_id")
        properties = {key: {"type": "string"} for key in required}
        if name.startswith("system-collapse_"):
            properties["note"] = {"type": "string"}
        controls.append({"name": name, "description": description, "schema": {
            "type": "object", "properties": properties, "required": required, "additionalProperties": False}})
    # Hosts can measure or discard the candidate before adopting these exact selections.
    selection = [{"candidate": prepared["candidate"], "windows": windows}]
    try:
        tools = client.call("projectNativeTools", apps=selection) + controls
        adopted = client.call("adoptTurn", apps=selection)
        if adopted["status"] != "adopted":
            raise RuntimeError(adopted)
    except RuntimeError as failure:
        try:
            client.call("discardObservation", candidate=prepared["candidate"])
        except RuntimeError as cleanup_error:
            failure.add_note(f"Discarding the candidate also failed: {cleanup_error}")
        raise
    return adopted["turn"], observation, messages, tools


def apply_window_tool(client, app, prepared, tool_name, *, app_id, view_id=None, note=""):
    turn, observation, _, tools = prepared
    if turn != client.current_turn:
        raise RuntimeError({"error": {"code": "TURN_NOT_ACTIVE"}})
    if app_id != app["appId"] or not any(tool["name"] == tool_name and "toolId" not in tool for tool in tools):
        raise ValueError("Choose a window action and App from this request.")
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
    view = {"viewId": args.pop("view_id")} if "view_id" in args else {}
    receipt = client.call("invoke", turn=turn, app=app["app"], observationId=tool["observationId"],
                          toolId=tool["toolId"], invocationId=invocation, input=args, **view)
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
