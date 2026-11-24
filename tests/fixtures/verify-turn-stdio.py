"""Verify the published Runtime's stdio entry and compare it to the product request."""

import argparse
import importlib.util
import json
import sys
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from shutil import copyfile
from tempfile import TemporaryDirectory
from threading import Thread
from time import monotonic, sleep
from urllib.request import Request, urlopen
from xml.etree import ElementTree
from xml.sax.saxutils import escape


def load_example(consumer):
    sys.dont_write_bytecode = True
    root = consumer / "node_modules" / "@aotui" / "runtime" / "examples"
    spec = importlib.util.spec_from_file_location("python_host", root / "python-host.py")
    example = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(example)
    return example, root / "files"


@contextmanager
def model_endpoint():
    requests = []
    script = {}

    class Provider(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            try:
                assert self.path == "/v1/chat/completions"
                calls = script["decide"](body)
                for name, _, _ in calls:
                    assert any(tool["function"]["name"] == name for tool in body["tools"]), name
                message = {"role": "assistant", "tool_calls": [
                    {"type": "function", "id": call_id, "function": {"name": name, "arguments": json.dumps(args)}}
                    for name, call_id, args in calls
                ]}
                response = json.dumps({"choices": [{"message": message}]})
                requests.append({"label": script["label"], "body": body, "response": message})
                self.send_response(200)
            except Exception as error:
                response = json.dumps({"error": str(error)})
                self.send_response(400)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(response.encode())

        def log_message(self, *_):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Provider) as server:
        owner = Thread(target=server.serve_forever)
        owner.start()
        try:
            def ask(label, decide, prepared=None, issue=None):
                routes = prepared[3] if prepared else []
                messages = list(prepared[2]) if prepared else [{"role": "user", "content": json.dumps(issue)}]
                body = {"model": "python-turn-local", "messages": [*messages, {"role": "user", "content": label}],
                        "tools": [{"type": "function", "function": {"name": tool["name"],
                                   "parameters": tool["schema"], "description": tool["description"]}} for tool in routes]}
                script.update(label=label, decide=decide)
                target = f"http://127.0.0.1:{server.server_port}/v1/chat/completions"
                request = Request(target, json.dumps(body).encode(), {"content-type": "application/json"})
                with urlopen(request, timeout=5) as reply:
                    return json.load(reply)["choices"][0]["message"]["tool_calls"]

            yield ask, requests
        finally:
            server.shutdown()
            owner.join()


def verify_numeric_ref(example, executable, consumer):
    with TemporaryDirectory(prefix="numeric-ref-", dir=consumer) as scratch:
        folder = Path(scratch)
        copyfile(Path(__file__).with_name("stdio-number-ref.mjs"), folder / "numeric.mjs")
        (folder / "aoapp.json").write_text(json.dumps({"app_name": "contract", "version": "0.1.0",
            "toolAuthoringProtocol": "view-type-tools-v7", "appLifecycleSupport": "app-lifecycle-v2",
            "entry": {"main": "./numeric.mjs"}}), encoding="utf-8")
        with example.RuntimeClient(executable) as client, model_endpoint() as (ask, requests):
            outcomes = []
            for compatible in (True, False):
                installation_id = "numeric" if compatible else "text"
                client.call("registerApp", installationId=installation_id, localPath=str(folder),
                            config={"compatible": compatible})
                app = client.call("openApp", installationId=installation_id)
                app["name"] = "contract"
                prepared = example.prepare_turn(client, app)
                address = f"$ref.{app['appId']}.page.label"
                echo = f"{app['appId']}-echo"

                def choose(body):
                    assert any(address in message["content"] for message in body["messages"])
                    tool = next(item["function"] for item in body["tools"] if item["function"]["name"] == echo)
                    parameter = tool["parameters"]["properties"]["value"]
                    if compatible:
                        assert [branch["type"] for branch in parameter["anyOf"]] == ["integer", "string"]
                        assert "$ref." in parameter["anyOf"][1]["description"]
                    else:
                        assert parameter == {"type": "integer"}
                    return [(echo, installation_id, {"value": address if compatible else 7})]

                decision, = ask(installation_id, choose, prepared)
                reply = example.invoke(client, app, prepared, decision["function"]["name"], decision["id"],
                                       **json.loads(decision["function"]["arguments"]))
                outcome = reply["receipt"]["outcome"]
                assert outcome["status"] == "succeeded"
                data = outcome["value"]["data"]
                assert type(data["value"]) is int and data["value"] == 7 and data["frozen"] and data["threadId"] > 0
                outcomes.append(reply["receipt"])
                client.call("closeApp", app=app["app"])
            shutdown = client.call("shutdown")
            assert shutdown["resourcesReleased"] and shutdown["workers"]["report"]["total"] == 0
            return {"requests": requests, "receipts": outcomes, "shutdown": shutdown}


def verify_bridge(example, executable, app_path, folder):
    (folder / "a.txt").write_text("Alpha", encoding="utf-8")
    (folder / "b.txt").write_text("Bravo", encoding="utf-8")

    def open_app(client):
        client.call("registerApp", installationId="files", localPath=str(app_path),
                    config={"folder": str(folder), "traceProjection": True})
        return client.call("openApp", installationId="files")

    def raw(client, line):
        client.process.stdin.write(line + "\n")
        client.process.stdin.flush()
        return json.loads(client.process.stdout.readline())

    with example.RuntimeClient(executable) as client, model_endpoint() as (ask, requests):
        malformed = raw(client, "{")
        unknown = raw(client, '{"id":"bad-method","method":"unrecognized"}')
        assert malformed["id"] is None and malformed["error"]["code"] == "INVALID_JSON"
        assert unknown["id"] == "bad-method" and unknown["error"]["code"] == "METHOD_NOT_FOUND"
        app = open_app(client)
        app["name"] = "turn_files"
        open_file, edit, set_writable = (f"{app['appId']}-{name}" for name in ("open_file", "edit", "set_writable"))

        def invoke(prepared, decision):
            model_args = decision["function"]
            route = next(tool for tool in prepared[3] if tool["name"] == model_args["name"])
            arguments = json.loads(model_args["arguments"])
            if route["name"] == "system-inspect_ref":
                return client.call("inspectRef", turn=prepared[0], **arguments)
            view = {"viewId": arguments.pop("view_id")} if "view_id" in arguments else {}
            return client.call("invoke", turn=prepared[0], app=app["app"], toolId=route["toolId"],
                               observationId=route["observationId"], invocationId=decision["id"],
                               input=arguments, **view)

        def choose_edit(file, invocation, new_text, before_reply=lambda: None):
            def decide(request):
                before_reply()
                pages = [ElementTree.fromstring(message["content"]) for message in request["messages"]
                         if message["content"].startswith("<view ")]
                view = next(view for view in pages if (view.text or "").startswith("\n# " + file + "\n"))
                assert sum(tool["function"]["name"] == edit for tool in request["tools"]) == 1
                view_id = view.attrib["view_id"]
                return [(edit, invocation, {"view_id": view_id, "text": new_text,
                                              "expected": f"$ref.turn_files.{view_id}.text"})]

            return decide

        first = example.prepare_turn(client, app)
        decisions = ask("open both files", lambda wire: [
            (open_file, "open-a", {"name": "a.txt"}), (open_file, "open-b", {"name": "b.txt"}),
        ], first)
        for decision in decisions:
            assert invoke(first, decision)["receipt"]["outcome"]["status"] == "succeeded"
        second = example.prepare_turn(client, app)
        with_old_handle = raw(client, json.dumps({"id": "old-turn", "method": "inspectRef",
                                                  "params": {"turn": first[0], "address": "$ref.turn_files.File_1.text", "mode": "value"}}))
        assert with_old_handle["error"]["code"] == "TURN_NOT_ACTIVE"
        mounts = {view["name"]: view for view in second[1]["views"]}
        target = mounts["a.txt"]
        address = f"$ref.turn_files.{target['id']}.text"
        edit_b = ask("edit B", choose_edit("b.txt", "edit-b", "Bravo updated"), second)[0]
        edited = invoke(second, edit_b)
        assert edited["receipt"]["outcome"]["status"] == "succeeded"
        assert (folder / "a.txt").read_text() == "Alpha" and (folder / "b.txt").read_text() == "Bravo updated"
        both_files = {"a.txt": "Alpha", "b.txt": "Bravo updated"}

        external = lambda: (folder / "a.txt").write_text("External", encoding="utf-8")
        decision = ask("external modification", choose_edit("a.txt", "external-change", "Invalid edit", external), second)[0]
        assert client.call("inspectRef", mode="value", turn=second[0], address=address)["value"] == "Alpha"
        conflict = invoke(second, decision)
        assert conflict["receipt"]["outcome"]["details"]["result"]["error"]["code"] == "FILE_CHANGED"
        assert (folder / "a.txt").read_text(encoding="utf-8") == "External"
        mount = {"app": app["app"], "viewId": target["id"], "viewInstanceId": target["viewInstanceId"]}
        client.call("revokeWindowAccess", **mount, turn=second[0])
        assert client.call("inspectRef", mode="value", turn=second[0], address=address)["status"] == "rejected"
        folded = invoke(second, {**decision, "id": "folded"})
        assert folded["receipt"]["executionPhase"] == "not-dispatched"
        assert client.call("closeView", **mount, turn=second[0])["status"] == "closed"
        assert invoke(second, ask("reopen same filename", lambda _: [(open_file, "reopen-a", {"name": "a.txt"})], second)[0]
                      )["receipt"]["outcome"]["status"] == "succeeded"
        old_page = invoke(second, ask("old mount", choose_edit("a.txt", "old-a", "No write"), second)[0])
        assert old_page["receipt"]["executionPhase"] == "not-dispatched"
        assert old_page["receipt"]["outcome"]["code"] == "VIEW_INSTANCE_REVOKED"

        third = example.prepare_turn(client, app)
        assert next(view for view in third[1]["views"] if view["name"] == "a.txt")["viewInstanceId"] != mount["viewInstanceId"]
        assert client.call("readDesktopReceipt", **edited["locator"])["receipt"] == edited["receipt"]
        toggle = [(set_writable, "disable-b", {"name": "b.txt", "writable": False}),
                  (set_writable, "enable-b", {"name": "b.txt", "writable": True})]
        for decision in ask("toggle edit", lambda _: toggle, third):
            assert invoke(third, decision)["receipt"]["outcome"]["status"] == "succeeded"
        old_activation = invoke(third, ask("old activation", choose_edit("b.txt", "old-edit-b", "No write"), third)[0])
        assert old_activation["receipt"]["executionPhase"] == "not-dispatched"
        assert old_activation["receipt"]["outcome"]["code"] == "TOOL_SOURCE_STALE"

        fourth = example.prepare_turn(client, app)
        fault = folder / ".fail-file-view"
        planned = ask("write then fail to present", choose_edit("b.txt", "write-then-fail", "Bravo recovered", fault.touch), fourth)[0]
        written = invoke(fourth, planned)
        outcome = written["receipt"]["outcome"]
        assert outcome["status"] == "succeeded" and outcome["value"]["data"]["saved"]
        assert outcome["value"]["data"]["projection"].startswith("SNAPSHOT_")
        assert (folder / "b.txt").read_text() == "Bravo recovered"
        failed = client.call("observe", app=app["app"])
        assert failed["status"] == "rejected" and failed["issue"]["code"].startswith("SNAPSHOT_")
        assert not ask("report projection failure", lambda wire: [] if not wire["tools"] else None, issue=failed)
        original = client.call("readDesktopReceipt", **written["locator"])
        assert original["receipt"] == written["receipt"]
        fault.unlink()
        until = monotonic() + 5
        while True:
            try:
                recovered = example.prepare_turn(client, app)
                break
            except RuntimeError:
                assert monotonic() < until, "The repaired local projection never became observable"
                sleep(0.02)
        assert not ask("show repaired page", lambda wire: [] if "Bravo recovered" in json.dumps(wire) else None, recovered)
        writes = [json.loads(line) for line in (folder / "edits.jsonl").read_text().splitlines()]
        assert writes == [{"name": "b.txt", "text": "Bravo updated"}, {"name": "b.txt", "text": "Bravo recovered"}]
        assert (folder / "a.txt").read_text() == "External"
        shutdown = client.call("shutdown")
        assert shutdown["ok"] and shutdown["resourcesReleased"] and shutdown["workers"]["report"]["total"] == 0
    with example.RuntimeClient(executable) as client:
        running = open_app(client)
        assert client.call("preview", app=running["app"])["status"] == "previewed"
    return {"malformed": malformed, "unknown": unknown, "stale": with_old_handle,
            "conflict": conflict["receipt"], "folded": folded["receipt"], "shutdown": shutdown, "eofExit": 0,
            "actualRequests": requests, "editB": edited, "firstDiskResult": both_files, "writes": writes,
            "oldMount": old_page, "oldActivation": old_activation,
            "projectionFailure": {"operation": written, "nextObservation": failed, "recovered": recovered[2]}}


def verify_windows(example, executable, app_path, folder):
    files = {"a.txt": "visible-a-accuracy-7919", "b.txt": "visible-b-accuracy-7919"}
    for name, text in files.items():
        (folder / name).write_text(text, encoding="utf-8")
    with example.RuntimeClient(executable) as client, model_endpoint() as (ask, requests):
        client.call("registerApp", installationId="files", localPath=str(app_path),
                    config={"folder": str(folder), "traceProjection": True})
        app = client.call("openApp", installationId="files")
        app["name"] = "turn_files"
        open_file, edit = (f"{app['appId']}-{name}" for name in ("open_file", "edit"))
        root = example.prepare_turn(client, app)
        for decision in ask("open files before folding", lambda _: [
            (open_file, "open-a", {"name": "a.txt"}), (open_file, "open-b", {"name": "b.txt"})], root):
            example.invoke(client, app, root, decision["function"]["name"], decision["id"], **json.loads(decision["function"]["arguments"]))
        opened = example.prepare_turn(client, app)
        views = {view["name"]: view for view in opened[1]["views"]}
        a, b = views["a.txt"], views["b.txt"]
        a_id, b_id = a["id"], b["id"]
        a_address, b_address = (f"$ref.turn_files.{view['id']}.text" for view in (a, b))
        def ref(prepared, address):
            return client.call("inspectRef", mode="value", turn=prepared[0], address=address)["status"]

        def window(kind, view=None, **args):
            return ("system-" + kind, kind + "-" + (view or "app"),
                    {"app_id": app["appId"], **({"view_id": view} if view else {}), **args})

        cases = []
        def capture(label, prepared, showing, decide=lambda _: [], note=None, budget=None):
            decisions = ask(label, decide, prepared)
            request = requests[-1]["body"]
            pages = {page.attrib["view_id"]: page.text
                     for page in (ElementTree.fromstring(msg["content"]) for msg in request["messages"]
                                  if msg["content"].startswith("<view "))}
            edit_tools = sum(tool["function"]["name"] == edit for tool in request["tools"])
            a_body = files["a.txt"] in pages.get(a_id, "")
            b_body = files["b.txt"] in pages.get(b_id, "") or "B edited while A folded" in pages.get(b_id, "")
            actual = (a_body, b_body, ref(prepared, a_address), ref(prepared, b_address), edit_tools)
            assert actual == showing, (label, actual)
            if note is not None:
                assert note in pages[a_id]
                assert any(escape(note) in message["content"] for message in request["messages"])
            if budget is not None:
                assert "Context budget" in pages[budget]
            cases.append(dict(phase=label, aBody=a_body, bBody=b_body, aRef=actual[2], bRef=actual[3], editTools=edit_tools))
            return decisions

        def apply(prepared, decision):
            return example.apply_window_tool(client, app, prepared, decision["function"]["name"],
                                             **json.loads(decision["function"]["arguments"]))

        decisions = capture("both opened", opened, (True, True, "ready", "ready", 1),
                            lambda _: [window("collapse_view", a_id, note="Keep <A> & resume")])
        assert apply(opened, decisions[0])["status"] == "succeeded"
        assert ref(opened, a_address) == "rejected" and ref(opened, b_address) == "ready"
        one = example.prepare_turn(client, app)
        def edit_b_then_expand(body):
            shaped = next(ElementTree.fromstring(part["content"]) for part in body["messages"]
                          if files["b.txt"] in part["content"])
            return [(edit, "still-edit-b", {"view_id": shaped.attrib["view_id"], "expected": b_address,
                                             "text": "B edited while A folded"}), window("expand_view", a_id)]
        decisions = capture("A folded, B open", one, (False, True, "rejected", "ready", 1),
                            edit_b_then_expand, note="Keep <A> & resume")
        applied = example.invoke(client, app, one, decisions[0]["function"]["name"], decisions[0]["id"],
                                 **json.loads(decisions[0]["function"]["arguments"]))
        assert (folder / "a.txt").read_text() == files["a.txt"]
        assert (folder / "b.txt").read_text() == "B edited while A folded"
        assert apply(one, decisions[1])["status"] == "succeeded"
        assert ref(one, a_address) == "rejected"
        reexpanded = example.prepare_turn(client, app)
        decisions = capture("A reopened in new turn", reexpanded, (True, True, "ready", "ready", 1),
                            lambda _: [window("collapse_view", a_id, note="Keep <A> & resume"), window("collapse_view", b_id)])
        for decision in decisions:
            assert apply(reexpanded, decision)["status"] == "succeeded"
        both = example.prepare_turn(client, app)
        decisions = capture("A and B folded", both, (False, False, "rejected", "rejected", 0),
                            lambda _: [window("expand_view", a_id)], note="Keep <A> & resume")
        assert "Note:" not in next(msg["content"] for msg in both[2] if f'view_id="{b_id}"' in msg["content"])
        assert apply(both, decisions[0])["status"] == "succeeded"
        assert ref(both, a_address) == "rejected"
        only_a = example.prepare_turn(client, app)
        for turn_id, mount_id, code in ((opened[0], a["viewInstanceId"], "TURN_NOT_ACTIVE"),
                                        (only_a[0], b["viewInstanceId"], "VIEW_INSTANCE_REVOKED")):
            try:
                client.call("revokeWindowAccess", app=app["app"], turn=turn_id, viewId=a_id, viewInstanceId=mount_id)
            except RuntimeError as error:
                reply = error.args[0]
                assert reply["error"]["code"] == code
                if code == "TURN_NOT_ACTIVE":
                    stale = {"error": reply["error"], "oldTurn": turn_id, "currentTurn": only_a[0],
                             "currentARefAfterOldHostMessage": ref(only_a, a_address)}
            else:
                raise AssertionError("A stale turn or mismatched mount revoked a current window")
        capture("only A reopened", only_a, (True, False, "ready", "rejected", 1))
        hint = example.prepare_turn(client, app, budget_hints={a_id})
        decisions = capture("A budget placeholder", hint, (False, False, "rejected", "rejected", 1),
                            lambda _: [(edit, "edit-hinted-a", {"view_id": a_id, "expected": files["a.txt"],
                                                                  "text": "A edited under budget hint"})], budget=a_id)
        budget_receipt = example.invoke(client, app, hint, decisions[0]["function"]["name"], decisions[0]["id"],
                                        **json.loads(decisions[0]["function"]["arguments"]))
        taking_note = ask("collapse with app note", lambda _: [window("collapse_app", note="<App> & child note")], hint)[0]
        assert apply(hint, taking_note)["status"] == "succeeded"
        app_folded = example.prepare_turn(client, app)
        expansion = ask("restore the App", lambda _: [window("expand_app")], app_folded)[0]
        assert "&lt;App&gt; &amp; child note" in app_folded[2][0]["content"]
        assert all("toolId" not in tool for tool in app_folded[3])
        assert apply(app_folded, expansion)["status"] == "succeeded"
        restored_app = example.prepare_turn(client, app)
        closing = ask("close still-folded B", lambda _: [window("close_view", b_id)], restored_app)[0]
        assert "Window collapsed." in next(msg["content"] for msg in restored_app[2] if f'view_id="{b_id}"' in msg["content"])
        closed = apply(restored_app, closing)
        assert closed["status"] == "closed"
        assert all(view["viewId"] != b_id for view in client.call("getAppWindows", app=app["app"])["views"])
        writes = [json.loads(line) for line in (folder / "edits.jsonl").read_text().splitlines()]
        assert writes == [{"name": "b.txt", "text": "B edited while A folded"}, {"name": "a.txt", "text": "A edited under budget hint"}]
        shutdown = client.call("shutdown")
        assert shutdown["resourcesReleased"] and shutdown["workers"]["report"]["total"] == 0
    return {"cases": cases, "lateHostControl": stale, "receipts": [applied, budget_receipt, closed],
            "writes": writes, "shutdown": shutdown, "actualLoopbackRequests": requests}


def compare(python_turn, product, folder):
    def view_map(messages):
        results = {}
        for message in messages:
            content = message["content"]
            if message["role"] != "user" or not isinstance(content, str) or not content.startswith("<view "):
                continue
            view = ElementTree.fromstring(content)
            assert set(view.attrib) == {"view_id", "view_type", "app_id", "app_name"}
            results[view.attrib["view_id"]] = (view.attrib, view.text.split("\n\nAvailable references\n")[0].strip("\n"))
        return results

    requests = {request["label"]: request["body"] for request in product["requests"]}
    wire = requests["edit-b"]
    observed = view_map(python_turn["messages"])
    assert view_map(wire["messages"]) == observed
    assert len(observed) == 3
    edit = [tool["function"]["parameters"] for tool in wire["tools"] if tool["function"]["name"] == "turn_files-edit"]
    assert edit == [tool["schema"] for tool in python_turn["tools"] if tool["name"] == "turn_files-edit"]
    assert edit[0]["properties"]["view_id"]["type"] == "string"
    assert (folder / "a.txt").read_text(encoding="utf-8") == "External"
    assert python_turn["files"] == product["files"] == {"a.txt": "Alpha", "b.txt": "Bravo updated"}
    phase = python_turn["receipt"]["executionPhase"]
    assert phase == "entered-returned" and python_turn["receipt"]["outcome"]["status"] == "succeeded"
    assert product["receipts"]["edit-b"]["executionPhase"] == phase
    assert product["receipts"]["edit-b"]["outcome"] == python_turn["receipt"]["outcome"]
    return {"views": list(observed), "sharedEditTools": len(edit), "files": python_turn["files"], "pythonExecutionPhase": phase}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("consumer", type=Path)
    parser.add_argument("python_turn", type=Path)
    parser.add_argument("product_turn", type=Path)
    args = parser.parse_args()
    consumer = args.consumer.resolve()
    example, app_path = load_example(consumer)
    with TemporaryDirectory(prefix="aotui-stdio-test-") as scratch:
        folder = Path(scratch)
        protocol = verify_bridge(example, consumer / "node_modules" / ".bin" / "aotui-stdio", app_path, folder)
        comparison = compare(json.loads(args.python_turn.read_text()), json.loads(args.product_turn.read_text()), folder)
    with TemporaryDirectory(prefix="aotui-stdio-windows-") as scratch:
        folding = verify_windows(example, consumer / "node_modules" / ".bin" / "aotui-stdio", app_path, Path(scratch))
    numeric = verify_numeric_ref(example, consumer / "node_modules" / ".bin" / "aotui-stdio", consumer)
    print(json.dumps({"protocol": protocol, "comparison": comparison, "folding": folding, "numericRef": numeric}))


if __name__ == "__main__":
    main()
