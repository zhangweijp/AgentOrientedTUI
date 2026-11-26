"""Verify the published Runtime's stdio entry and compare it to the product request."""

import argparse
import importlib.util
import json
import subprocess
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


def model_body(label, prepared=None, issue=None):
    routes = prepared[3] if prepared else []
    messages = list(prepared[2]) if prepared else [{"role": "user", "content": json.dumps(issue)}]
    return {"model": "python-turn-local", "messages": [*messages, {"role": "user", "content": label}],
            "tools": [{"type": "function", "function": {"name": tool["name"], "parameters": tool["schema"],
                                                       "description": tool["description"]}} for tool in routes]}


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
                body = model_body(label, prepared, issue)
                script.update(label=label, decide=decide)
                target = f"http://127.0.0.1:{server.server_port}/v1/chat/completions"
                request = Request(target, json.dumps(body).encode(), {"content-type": "application/json"})
                with urlopen(request, timeout=5) as reply:
                    return json.load(reply)["choices"][0]["message"]["tool_calls"]

            yield ask, requests
        finally:
            server.shutdown()
            owner.join()


def stage_numeric_ref(folder):
    copyfile(Path(__file__).with_name("stdio-number-ref.mjs"), folder / "numeric.mjs")
    (folder / "aoapp.json").write_text(json.dumps({"app_name": "contract", "version": "0.1.0",
        "toolAuthoringProtocol": "view-type-tools-v8", "appLifecycleSupport": "app-lifecycle-v2",
        "entry": {"main": "./numeric.mjs"}}), encoding="utf-8")


def verify_numeric_ref(example, executable, consumer):
    with TemporaryDirectory(prefix="numeric-ref-", dir=consumer) as scratch:
        folder = Path(scratch)
        stage_numeric_ref(folder)
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

def verify_client_stream(example, executable, consumer):
    for options, diagnostic in [({"major_version": 81}, "81"), ({"required": ["missing-host-feature"]}, "missing-host-feature")]:
        try:
            example.RuntimeClient(executable, **options)
        except example.ProtocolError as error:
            assert error.code == "PROTOCOL_UNSUPPORTED" and diagnostic in error.reply["error"]["message"]
        else:
            raise AssertionError("The Python client accepted an unsupported handshake")

    def wait_file(file):
        deadline = monotonic() + 5
        while not file.exists():
            assert monotonic() < deadline, f"Missing fixture marker {file.name}"
            sleep(0.01)

    fixture_source = Path(__file__).with_name("stdio-v1")
    with TemporaryDirectory(prefix="stdio-client-app-", dir=consumer) as staged, \
            TemporaryDirectory(prefix="stdio-client-files-") as data:
        folder = Path(data)
        for name in ("aoapp.json", "app.mjs"):
            copyfile(fixture_source / name, Path(staged) / name)
        for name, text in (("A.txt", "Alpha"), ("B.txt", "Bravo")):
            (folder / name).write_text(text, encoding="utf-8")
        with example.RuntimeClient(executable, required=["output-events"], optional=["future-output"]) as client:
            assert client.capabilities == {"output-events"}

            old_factory = folder / "old-factory"
            old_factory.mkdir()
            copyfile(fixture_source / "aoapp.json", old_factory / "aoapp.json")
            (old_factory / "app.mjs").write_text("""
import { writeFileSync } from 'node:fs';
export default { app_name: 'stdio_files', toolAuthoringProtocol: 'view-type-tools-obsolete',
    appLifecycleSupport: 'app-lifecycle-v2', initialize({ launchConfig }) {
        writeFileSync(launchConfig.marker, 'unexpected initialization');
    } };
""", encoding="utf-8")
            marker = folder / "obsolete-app-started"
            client.call("registerApp", installationId="old-factory", localPath=str(old_factory), config={"marker": str(marker)})
            try:
                client.call("openApp", installationId="old-factory")
            except example.ProtocolError as error:
                assert error.code == "PROTOCOL_UNSUPPORTED" and "view-type-tools-" in error.reply["error"]["message"]
                old_factory_error = error.reply["error"]
            else:
                raise AssertionError("The obsolete JS App factory initialized")
            assert not marker.exists()

            client.call("registerApp", installationId="stream", localPath=staged, config={"folder": data})
            app = client.call("openApp", installationId="stream")
            assert client.call("subscribeOutput", apps=[app["app"]]) is None
            before = example.prepare_turn(client, app)
            assert any("Bravo" in message["content"] for message in before[2])
            sent = client.request_id
            (folder / "B.txt").write_text("Background result", encoding="utf-8")
            (folder / "projection-release").touch()
            (folder / "projection-hold").touch()
            wait_file(folder / "projection-entered")
            (folder / "attention").touch()
            attention = client.next_event(timeout=5)
            while attention["signal"]["reason"] != "attention_requested":
                attention = client.next_event(timeout=5)
            assert attention["event"] == "output" and "id" not in attention
            assert attention["signal"]["instanceId"] == app["instanceId"]
            assert client.request_id == sent and client.current_turn == before[0]
            adopted = example.prepare_turn(client, app)
            assert any("Background result" in message["content"] for message in adopted[2])
            a = next(view for view in adopted[1]["views"] if view["name"] == "A.txt")
            slow = client.send("invokeNative", turn=adopted[0], name=f"{app['appId']}-edit",
                               invocationId="python-stream", input={"view_id": a["id"], "text": "First", "wait": True})
            wait_file(folder / "edit-entered")
            try:
                running = client.send("listApps").result(timeout=2)
                assert any(item.get("appInstanceId") == app["instanceId"] for item in running) and not slow.done()
            finally:
                (folder / "edit-release").touch()
            result = slow.result(timeout=5)
            assert result["receipt"]["outcome"]["status"] == "succeeded"
            assert (folder / "A.txt").read_text(encoding="utf-8") == "First"
            advanced = example.prepare_turn(client, app)
            assert any("First" in message["content"] for message in advanced[2])
            assert client.call("shutdown")["resourcesReleased"]
    return {"idleAttention": attention, "observedAfterAttention": "Background result",
            "fastCatalogWhileSlow": True, "receipt": result["receipt"],
            "incompatibleHostRejected": True, "requiredCapabilityRejected": True, "oldFactoryError": old_factory_error}

def verify_command_host(example, executable, consumer):
    program = consumer / "node_modules" / "@aotui" / "runtime" / "examples" / "python-files.py"
    if not program.is_file():
        with example.RuntimeClient(executable, optional=["command-apps"]) as client:
            assert "command-apps" not in client.capabilities
        return {"negotiated": False}

    def rejected(client, code, method, **params):
        try:
            client.call(method, **params)
        except example.ProtocolError as error:
            assert error.code == code, error.reply
            return error.reply["error"]
        raise AssertionError(f"{method} accepted the unsupported request")

    command = [sys.executable, "-B", "-u", str(program)]
    with example.RuntimeClient(executable) as client:
        unnegotiated = rejected(client, "PROTOCOL_UNSUPPORTED", "registerApp", installationId="unused",
                                name="process_files", command=command)
        assert client.call("listApps") == []

    with TemporaryDirectory(prefix="stdio-command-files-") as temp, \
            example.RuntimeClient(executable, required=["command-apps", "output-events"]) as client:
        folder = Path(temp)
        for name, text in (("A.txt", "Alpha"), ("B.txt", "Bravo")):
            (folder / name).write_text(text, encoding="utf-8")
        for key, expression in (("bad-version", "major=83"), ("bad-capability", "requires=('external-extra',)")):
            wrapper = folder / (key + ".py")
            wrapper.write_text('import runpy, sys\nrunpy.run_path(sys.argv[1])["run"](' + expression + ')\n', encoding="utf-8")
            client.call("registerApp", installationId=key, name="rejected_files",
                        command=[sys.executable, "-B", "-u", str(wrapper), str(program)], config={"folder": temp})
        bad_version = rejected(client, "PROTOCOL_UNSUPPORTED", "openApp", installationId="bad-version")
        assert "aotui-app major 1" in bad_version["message"] and "83" in bad_version["message"] and bad_version["path"] == "$.major"
        bad_capability = rejected(client, "CAPABILITY_REQUIRED", "openApp", installationId="bad-capability")
        assert "external-extra" in bad_capability["message"] and bad_capability["path"] == "$.requires"
        assert all(item["status"] != "running" for item in client.call("listApps"))
        rejected(client, "INVALID_REQUEST", "registerApp", installationId="mixed", name="process_files",
                 command=command, localPath=str(folder))
        wrapper = folder / "run-with-argv.py"
        wrapper.write_text('import runpy, sys\nassert sys.argv[2:] == ["", "literal & text"]\nrunpy.run_path(sys.argv[1])["run"]()\n',
                           encoding="utf-8")
        client.call("registerApp", installationId="process", name="process_files",
                    command=[sys.executable, "-B", "-u", str(wrapper), str(program), "", "literal & text"], config={"folder": temp})
        app = client.call("openApp", installationId="process")
        base = example.prepare_turn(client, app)
        tool = f"{app['appId']}-open_file"
        example.invoke(client, app, base, tool, "command-open-a", name="A.txt")
        example.invoke(client, app, base, tool, "command-open-b", name="B.txt")
        prepared = example.prepare_turn(client, app)
        b = next(view for view in prepared[1]["views"] if view["name"] == "B.txt")
        edit = f"{app['appId']}-edit"
        assert [tool["name"] for tool in prepared[3] if tool["name"] == edit] == [edit]
        assert any("B.txt" in page["content"] and "Bravo" in page["content"] for page in prepared[2])
        updated = example.invoke(client, app, prepared, edit, "command-edit-b", view_id=b["id"], text="Bravo from Python")
        assert (folder / "A.txt").read_text(encoding="utf-8") == "Alpha"
        assert (folder / "B.txt").read_text(encoding="utf-8") == "Bravo from Python"
        assert client.call("readDesktopReceipt", **updated["locator"])["receipt"] == updated["receipt"]
        closed = client.call("closeApp", app=app["app"])
        probe = Path(__file__).with_name("external-app-behavior.py")
        vectors = program.with_name("app-protocol-v1-vectors.json")
        client.call("registerApp", installationId="process-notify", name="process_notify",
                    command=[sys.executable, "-B", "-u", str(probe), str(program), str(vectors), "optional-attention"],
                    config={"folder": temp})
        notifying = client.call("openApp", installationId="process-notify")
        client.call("subscribeOutput", apps=[notifying["app"]])
        (folder / "attention").touch()
        attention = client.next_event(timeout=5)
        assert attention["event"] == "output" and "id" not in attention
        assert attention["signal"]["reason"] == "attention_requested"
        assert attention["signal"]["instanceId"] == notifying["instanceId"]
        report = client.call("shutdown")
        assert closed["resourcesReleased"] and report["resourcesReleased"] and report["workers"]["report"]["total"] == 0
        return {"negotiated": True, "invalidAppVersion": bad_version, "missingAppCapability": bad_capability,
                "unnegotiatedHost": unnegotiated, "receipt": updated, "close": closed, "attention": attention, "shutdown": report}


def verify_bridge(example, executable, app_path, folder):
    (folder / "a.txt").write_text("Alpha", encoding="utf-8")
    (folder / "b.txt").write_text("Bravo", encoding="utf-8")

    def open_app(client):
        client.call("registerApp", installationId="files", localPath=str(app_path),
                    config={"folder": str(folder), "traceProjection": True})
        return client.call("openApp", installationId="files")

    raw = subprocess.run([executable], input='\n'.join([
        "{",
        '{"id":"uninitialized","method":"desktop"}',
        '{"id":"hello","method":"initialize","params":{"protocol":"aotui-stdio","majorVersion":1}}',
        '{"id":"bad-method","method":"unrecognized"}',
    ]) + "\n", capture_output=True, encoding="utf-8", timeout=15, check=True)
    replies = {reply["id"]: reply for reply in map(json.loads, raw.stdout.splitlines())}
    malformed, unknown = replies[None], replies["bad-method"]
    assert malformed["error"]["code"] == "INVALID_JSON"
    assert replies["uninitialized"]["error"]["code"] == "PROTOCOL_UNSUPPORTED"
    assert replies["hello"]["result"] == {"protocol": "aotui-stdio", "majorVersion": 1, "capabilities": []}
    assert unknown["error"]["code"] == "METHOD_NOT_FOUND"

    with example.RuntimeClient(executable) as client, model_endpoint() as (ask, requests):
        app = open_app(client)
        app["name"] = "turn_files"
        open_file, edit, set_writable = (f"{app['appId']}-{name}" for name in ("open_file", "edit", "set_writable"))

        def invoke(prepared, decision):
            return invoke_native(client, prepared, decision)

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
        try:
            client.call("inspectRef", turn=first[0], address="$ref.turn_files.File_1.text", mode="value")
        except example.ProtocolError as error:
            assert error.code == "TURN_NOT_ACTIVE", error
            with_old_handle = error.reply
        else:
            raise AssertionError("The replaced turn still accepted a Ref inspection")
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
        with example.candidate_scope(client) as scope_id:
            failed = client.call("observe", app=app["app"], scopeId=scope_id)
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


def invoke_native(client, prepared, decision):
    model_call = decision["function"]
    return client.call("invokeNative", turn=prepared[0], name=model_call["name"],
                       invocationId=decision["id"], input=json.loads(model_call["arguments"]))


def assembled_turn(presented, adopted, observation):
    views = [{"role": "user", "content": view["content"], "region": view["region"]} for view in presented["views"]]
    messages = [{"role": "user", "content": presented["instruction"]},
                *(view for view in views if view["region"] == "static"),
                {"role": "user", "content": presented["desktop"]},
                *(view for view in views if view["region"] == "dynamic")]
    return adopted["turn"], observation, messages, presented["tools"]


def project_ts(projector, client, app, observation, plan, presented):
    entry = next(item for item in client.call("listApps") if item["appId"] == app["appId"])
    live = client.call("getAppWindows", app=app["app"])
    supplied = {"observation": observation, "plan": plan, "appLayout": plan["apps"][0], "entry": entry, "live": live}
    completed = subprocess.run(["node", str(projector)], input=json.dumps(supplied),
                               text=True, stdout=subprocess.PIPE, check=True)
    direct = json.loads(completed.stdout)
    assert direct == {key: presented[key] for key in direct}
    return direct


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
                assert "model context budget" in pages[budget]
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
        capture("A budget placeholder, B folded", hint, (False, False, "rejected", "rejected", 0), budget=a_id)
        taking_note = ask("collapse with app note", lambda _: [window("collapse_app", note="<App> & child note")], hint)[0]
        assert apply(hint, taking_note)["status"] == "succeeded"
        app_folded = example.prepare_turn(client, app)
        expansion = ask("restore the App", lambda _: [window("expand_app")], app_folded)[0]
        assert any("&lt;App&gt; &amp; child note" in item["content"] for item in app_folded[2])
        assert all("toolId" not in tool for tool in app_folded[3])
        assert apply(app_folded, expansion)["status"] == "succeeded"
        restored_app = example.prepare_turn(client, app)
        closing = ask("close still-folded B", lambda _: [window("close_view", b_id)], restored_app)[0]
        assert "Collapsed" in next(msg["content"] for msg in restored_app[2] if f'view_id="{b_id}"' in msg["content"])
        closed = apply(restored_app, closing)
        assert closed["status"] == "closed"
        assert all(view["viewId"] != b_id for view in client.call("getAppWindows", app=app["app"])["views"])
        writes = [json.loads(line) for line in (folder / "edits.jsonl").read_text().splitlines()]
        assert writes == [{"name": "b.txt", "text": "B edited while A folded"}]
        shutdown = client.call("shutdown")
        assert shutdown["resourcesReleased"] and shutdown["workers"]["report"]["total"] == 0
    return {"cases": cases, "lateHostControl": stale, "receipts": [applied, closed],
            "writes": writes, "shutdown": shutdown, "actualLoopbackRequests": requests}


def verify_hint_and_replan(example, executable, app_path, folder, projector):
    original_a = "body-A <file> & first\rsecond"
    original_b = "body-B unique " + "x" * 700
    new_b = "B committed once"
    paths = {name: folder / name for name in ("a.txt", "b.txt")}
    paths["a.txt"].write_bytes(original_a.encode())
    paths["b.txt"].write_bytes(original_b.encode())
    capabilities = ["open", "close", "collapse", "expand", "collapseView", "expandView", "closeView", "inspectRef"]

    def pages(body):
        return {page.attrib["view_id"]: page for page in map(ElementTree.fromstring, (
            message["content"] for message in body["messages"] if message["content"].startswith("<view ")))}

    def model_args(name, invocation_id, **args):
        return (name, invocation_id, args)

    def wire_size(label, turn):
        return len(json.dumps(model_body(label, turn)).encode())

    with example.RuntimeClient(executable) as client, model_endpoint() as (ask, requests):
        client.call("registerApp", installationId="files", localPath=str(app_path),
                    config={"folder": str(folder), "traceProjection": True})
        app = client.call("openApp", installationId="files")
        open_file, edit = (f"{app['appId']}-{name}" for name in ("open_file", "edit"))
        root = example.prepare_turn(client, app)
        for decision in ask("open both pages for the hint trial", lambda _: [
            (open_file, "open-a", {"name": "a.txt"}), (open_file, "open-b", {"name": "b.txt"})], root):
            assert invoke_native(client, root, decision)["receipt"]["outcome"]["status"] == "succeeded"

        opened = example.prepare_turn(client, app)
        mounts = {view["name"]: view for view in opened[1]["views"]}
        a, b = mounts["a.txt"], mounts["b.txt"]
        a_id, b_id = a["id"], b["id"]
        hint = example.prepare_turn(client, app, budget_hints={a_id})
        a_ref, b_ref = (f"$ref.{app['appId']}.{view['id']}.text" for view in (a, b))

        def choose_b(body):
            views = pages(body)
            assert "model context budget" in views[a_id].text
            assert original_a not in views[a_id].text and a_ref not in views[a_id].text
            assert original_b in views[b_id].text and b_ref in views[b_id].text
            assert sum(tool["function"]["name"] == edit for tool in body["tools"]) == 1
            return [model_args(edit, "write-b", view_id=views[b_id].attrib["view_id"], expected=b_ref, text=new_b)]

        decision, = ask("A hint, B body", choose_b, hint)
        applied = invoke_native(client, hint, decision)
        assert applied["receipt"]["outcome"]["status"] == "succeeded"
        assert client.call("inspectRef", turn=hint[0], address=a_ref, mode="value")["status"] == "rejected"
        forbidden, = ask("try the hinted A against the same shared edit", lambda _: [
            model_args(edit, "do-not-write-a", view_id=a_id, expected=original_a, text="Forbidden")], hint)
        denied_a = invoke_native(client, hint, forbidden)
        assert denied_a["receipt"]["executionPhase"] == "not-dispatched"
        assert denied_a["receipt"]["outcome"]["code"] == "TOOL_UNAVAILABLE"

        def close_b(turn, mount):
            return client.call("closeView", app=app["app"], turn=turn[0], viewId=mount["id"],
                               viewInstanceId=mount["viewInstanceId"])

        assert close_b(hint, b)["status"] == "closed"
        reopen, old_b = ask("reopen B and try the old receiving page", lambda _: [
            (open_file, "reopen-b", {"name": "b.txt"}),
            model_args(edit, "do-not-write-old-b", view_id=b_id, expected=new_b, text="Forbidden")], hint)
        assert invoke_native(client, hint, reopen)["receipt"]["outcome"]["status"] == "succeeded"
        denied_b = invoke_native(client, hint, old_b)
        assert denied_b["receipt"]["executionPhase"] == "not-dispatched"
        assert denied_b["receipt"]["outcome"]["code"] == "VIEW_INSTANCE_REVOKED"
        active = example.prepare_turn(client, app)
        new_mount_b = next(view for view in active[1]["views"] if view["name"] == "b.txt")
        assert new_mount_b["viewInstanceId"] != b["viewInstanceId"]

        before = len(requests)
        label = "use the final A-only layout"
        with example.candidate_scope(client) as scope_id:
            candidate = client.call("observe", app=app["app"], scopeId=scope_id)
            assert candidate["status"] == "prepared"
            observation = candidate["observation"]
            layout = {"candidate": candidate["candidate"],
                      "views": [{"viewInstanceId": view["viewInstanceId"], "kind": "body"} for view in observation["views"]]}
            plan = {"apps": [layout], "catalog": ["files"], "capabilities": capabilities}
            strict_plan = {**plan, "strict": True}
            strict_trial = client.call("presentTurn", scopeId=scope_id, **strict_plan)
            strict_ts = project_ts(projector, client, app, observation, strict_plan, strict_trial)
            trial = client.call("presentTurn", scopeId=scope_id, **plan)
            original_ts = project_ts(projector, client, app, observation, plan, trial)
            for control, required in (("system-collapse_app", ["app_id"]),
                                      ("system-collapse_view", ["app_id", "view_id"])):
                default_tool = next(tool for tool in trial["tools"] if tool["name"] == control)
                strict_tool = next(tool for tool in strict_trial["tools"] if tool["name"] == control)
                assert default_tool["schema"]["required"] == required
                assert strict_tool["schema"]["required"] == [*required, "note"]
            initial_size = wire_size(label, assembled_turn(trial, {"turn": None}, observation))
            assert trial["issues"] == [] and new_mount_b["id"] in trial["desktop"]
            assert close_b(active, new_mount_b)["status"] == "closed"
            changed = client.call("adoptTurn", scopeId=scope_id, presentation=trial["presentation"])
            assert changed["status"] == "rejected" and changed["issue"]["code"] == "OBSERVATION_WINDOW_CHANGED", changed
            assert client.current_turn == active[0] and len(requests) == before
            assert client.call("inspectRef", turn=active[0], address=a_ref, mode="value")["value"] == original_a

            b_layout = next(view for view in layout["views"] if view["viewInstanceId"] == new_mount_b["viewInstanceId"])
            b_layout["kind"] = "omitted"
            final = client.call("presentTurn", scopeId=scope_id, **plan)
            final_ts = project_ts(projector, client, app, observation, plan, final)
            final_size = wire_size(label, assembled_turn(final, {"turn": None}, observation))
            # Re-measure after the supplied live mount list changes. Only the checked input is sent.
            budget = initial_size - 1
            assert final_size <= budget < initial_size and len(requests) == before
            assert final["issues"] == []
            try:
                client.call("adoptTurn", scopeId=scope_id, presentation=trial["presentation"])
            except RuntimeError as error:
                superseded = error.args[0]
                assert superseded["error"]["code"] == "PRESENTATION_UNAVAILABLE", superseded
            else:
                raise AssertionError("The replaced trial is no longer adoptable")
            adopted = client.call("adoptTurn", scopeId=scope_id, presentation=final["presentation"])
            assert adopted["status"] == "adopted", adopted
            final_turn = assembled_turn(final, adopted, observation)
            assert final["apps"][0]["windows"]["activeViews"] == [
                {"viewId": view["id"], "viewInstanceId": view["viewInstanceId"]}
                for view in observation["views"] if view["name"] != "b.txt"]

            def choose_a_only(body):
                assert len(json.dumps(body).encode()) == final_size
                view_pages = pages(body)
                assert set(view_pages) == {"directory", a_id}
                assert view_pages[a_id].attrib["region"] == "dynamic"
                assert view_pages["directory"].attrib["region"] == "static"
                assert original_a in view_pages[a_id].text and a_ref in view_pages[a_id].text
                raw = [message["content"] for message in body["messages"]]
                assert any("first&#13;second" in message and "&lt;file&gt; &amp;" in message for message in raw)
                assert not any(new_mount_b["id"] in message or new_b in message for message in raw)
                assert sum(tool["function"]["name"] == edit for tool in body["tools"]) == 1
                # The only edit schema is shared. Try the omitted receiver to prove it has no edit capability.
                return [model_args(edit, "do-not-write-omitted-b", view_id=new_mount_b["id"],
                                   expected=new_b, text="Forbidden")]

            premature_sends = len(requests) - before
            assert premature_sends == 0
            off_scope, = ask(label, choose_a_only, final_turn)
            refused = invoke_native(client, final_turn, off_scope)
            assert refused["receipt"]["executionPhase"] == "not-dispatched", refused

        writes = [json.loads(line) for line in (folder / "edits.jsonl").read_text().splitlines()]
        disk = {name: path.read_bytes().decode() for name, path in paths.items()}
        assert writes == [{"name": "b.txt", "text": new_b}]
        assert disk == {"a.txt": original_a, "b.txt": new_b}
        shutdown = client.call("shutdown")
        assert shutdown["resourcesReleased"] and shutdown["workers"]["report"]["total"] == 0
    return {"requests": requests, "writes": writes, "disk": disk, "shutdown": shutdown,
            "receipts": {"writtenB": applied, "hintA": denied_a, "oldB": denied_b, "omittedB": refused},
            "replan": {"trialBytes": initial_size, "finalBytes": final_size, "budgetBytes": budget,
                       "firstAdoption": changed, "superseded": superseded, "finalAdoption": adopted,
                       "sentBeforeFinalAdoption": premature_sends, "sentAfterFinalAdoption": len(requests) - before},
            "matchedTs": {"original": original_ts, "strict": strict_ts, "final": final_ts}}


def verify_app_replan(example, executable, app_path, folder, other_app):
    stage_numeric_ref(other_app)
    (folder / "a.txt").write_text("Original app A", encoding="utf-8")
    (folder / "b.txt").write_text("Unopened file in A", encoding="utf-8")
    with example.RuntimeClient(executable) as client, model_endpoint() as (ask, requests):
        client.call("registerApp", installationId="files", localPath=str(app_path),
                    config={"folder": str(folder), "traceProjection": True})
        client.call("registerApp", installationId="other-app", localPath=str(other_app), config={"compatible": True})
        first = client.call("openApp", installationId="files")
        second = client.call("openApp", installationId="other-app")
        assert len({first["appId"], second["appId"]}) == 2
        root = example.prepare_turn(client, first)
        example.invoke(client, first, root, f"{first['appId']}-open_file", "open-file-in-a", name="a.txt")
        label = "send the measured one-App request"
        with example.candidate_scope(client) as scope_id:
            a, b = [client.call("observe", app=app["app"], scopeId=scope_id) for app in (first, second)]
            assert a["status"] == b["status"] == "prepared"
            a_view = next(view for view in a["observation"]["views"] if view["name"] == "a.txt")
            a_address = f"$ref.{first['appId']}.{a_view['id']}.text"
            layout = [{"candidate": candidate["candidate"],
                       "views": [{"viewInstanceId": view["viewInstanceId"], "kind": "body"}
                                 for view in candidate["observation"]["views"]]} for candidate in (a, b)]
            capabilities = ["open", "close", "collapse", "expand", "collapseView", "expandView", "closeView", "inspectRef"]
            trial = client.call("presentTurn", scopeId=scope_id, apps=layout, catalog=["files", "other-app"],
                                capabilities=capabilities)
            assert len(trial["apps"]) == 2 and trial["issues"] == []
            assert any(view["appId"] == second["appId"] for view in trial["views"])
            assert any(tool["name"] == f"{second['appId']}-echo" for tool in trial["tools"])
            trial_input = model_body(label, assembled_turn(trial, {"turn": None}, a["observation"]))
            trial_bytes = len(json.dumps(trial_input).encode())

            assert client.call("closeApp", app=second["app"])["resourcesReleased"]
            rejected = client.call("adoptTurn", scopeId=scope_id, presentation=trial["presentation"])
            assert rejected["status"] == "rejected", rejected
            assert not requests and client.current_turn == root[0]
            final = client.call("presentTurn", scopeId=scope_id, apps=layout[:1], catalog=["files"], capabilities=capabilities)
            assert final["apps"] == [trial["apps"][0]] and final["issues"] == []
            final_input = model_body(label, assembled_turn(final, {"turn": None}, a["observation"]))
            final_bytes = len(json.dumps(final_input).encode())
            budget = trial_bytes - 1
            assert final_bytes <= budget < trial_bytes
            adopted = client.call("adoptTurn", scopeId=scope_id, presentation=final["presentation"])
            assert adopted["status"] == "adopted" and not requests
            prepared = assembled_turn(final, adopted, a["observation"])
            assert client.call("inspectRef", turn=prepared[0], address=a_address, mode="value") == {
                "status": "ready", "value": "Original app A",
            }

            edit = f"{first['appId']}-edit"

            def choose_a(body):
                assert body == final_input
                messages = [message["content"] for message in body["messages"]]
                assert all(f'app_id="{second["appId"]}"' not in message and "other-app" not in message for message in messages)
                assert any(a_address in message for message in messages)
                assert all(not tool["function"]["name"].startswith(second["appId"] + "-") for tool in body["tools"])
                receiving_view = next(ElementTree.fromstring(message).attrib["view_id"] for message in messages
                                      if message.startswith("<view ") and a_address in message)
                return [(edit, "write-through-original-a", {"view_id": receiving_view, "expected": a_address,
                                                           "text": "Saved by app A"})]

            decision, = ask(label, choose_a, prepared)
            applied = invoke_native(client, prepared, decision)
            assert applied["receipt"]["outcome"]["status"] == "succeeded"
            assert applied["receipt"]["observationId"] == a["observation"]["observationId"]
            assert len(requests) == 1
        writes = [json.loads(line) for line in (folder / "edits.jsonl").read_text().splitlines()]
        assert writes == [{"name": "a.txt", "text": "Saved by app A"}]
        assert (folder / "a.txt").read_text() == "Saved by app A"
        assert (folder / "b.txt").read_text() == "Unopened file in A"
        shutdown = client.call("shutdown")
        assert shutdown["resourcesReleased"] and shutdown["workers"]["report"]["total"] == 0
    return {"appIds": [first["appId"], second["appId"]], "trialInput": trial_input, "requests": requests,
            "rejectedAdoption": rejected, "adoption": adopted, "originalAObservation": a["candidate"],
            "budgetBytes": budget, "trialBytes": trial_bytes, "finalBytes": final_bytes, "receipt": applied,
            "writes": writes, "shutdown": shutdown}


def compare(python_turn, product, folder):
    def view_map(messages):
        results = {}
        for message in messages:
            content = message["content"]
            if message["role"] != "user" or not isinstance(content, str) or not content.startswith("<view "):
                continue
            view = ElementTree.fromstring(content)
            assert set(view.attrib) == {"view_id", "view_type", "app_id", "app_name", "region"}
            results[view.attrib["view_id"]] = (view.attrib, content)
        return results

    requests = {request["label"]: request["body"] for request in product["requests"]}
    wire = requests["edit-b"]
    observed = view_map(python_turn["messages"])
    assert view_map(wire["messages"]) == observed
    assert len(observed) == 3
    business = {tool["name"]: tool["schema"] for tool in python_turn["tools"] if "toolId" in tool}
    product_business = {tool["function"]["name"]: tool["function"]["parameters"] for tool in wire["tools"]
                        if tool["function"]["name"].startswith("turn_files-")}
    assert business == product_business
    assert business["turn_files-edit"]["properties"]["view_id"]["type"] == "string"
    assert (folder / "a.txt").read_text(encoding="utf-8") == "External"
    assert python_turn["files"] == product["files"] == {"a.txt": "Alpha", "b.txt": "Bravo updated"}
    phase = python_turn["receipt"]["executionPhase"]
    assert phase == "entered-returned" and python_turn["receipt"]["outcome"]["status"] == "succeeded"
    assert product["receipts"]["edit-b"]["executionPhase"] == phase
    assert product["receipts"]["edit-b"]["outcome"] == python_turn["receipt"]["outcome"]
    return {"views": list(observed), "businessTools": list(business), "files": python_turn["files"], "pythonExecutionPhase": phase}


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
    with TemporaryDirectory(prefix="stdio-comparison-", dir=consumer) as fixture_dir, \
            TemporaryDirectory(prefix="aotui-stdio-replan-") as scratch:
        projector = Path(fixture_dir) / "project.mjs"
        copyfile(Path(__file__).with_name("project-stdio-turn.mjs"), projector)
        hint = verify_hint_and_replan(example, consumer / "node_modules" / ".bin" / "aotui-stdio",
                                      app_path, Path(scratch), projector)
    with TemporaryDirectory(prefix="stdio-second-app-", dir=consumer) as fixture_dir, \
            TemporaryDirectory(prefix="aotui-stdio-app-replan-") as scratch:
        app_replan = verify_app_replan(example, consumer / "node_modules" / ".bin" / "aotui-stdio",
                                       app_path, Path(scratch), Path(fixture_dir))
    numeric = verify_numeric_ref(example, consumer / "node_modules" / ".bin" / "aotui-stdio", consumer)
    stream = verify_client_stream(example, consumer / "node_modules" / ".bin" / "aotui-stdio", consumer)
    command = verify_command_host(example, consumer / "node_modules" / ".bin" / "aotui-stdio", consumer)
    print(json.dumps({"protocol": protocol, "comparison": comparison, "folding": folding, "hintAndReplan": hint,
                      "appReplan": app_replan, "numericRef": numeric, "stream": stream, "command": command}))


if __name__ == "__main__":
    main()
