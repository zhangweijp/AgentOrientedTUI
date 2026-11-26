"""Frozen Host v1 wire fixture. Uses the executable and inert App files passed on the command line."""

import argparse
from collections import deque
import hashlib
import json
from pathlib import Path
from queue import Empty, SimpleQueue
from select import select
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
from time import monotonic, sleep
from xml.etree.ElementTree import fromstring

PROTOCOL = "aotui-stdio"
CAPABILITIES = ["open", "close", "closeView", "collapseView", "expandView", "inspectRef"]
VECTORS = json.loads(Path(__file__).with_name("vectors.json").read_text(encoding="utf-8"))


class Host:
    def __init__(self, executable):
        self.child = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      text=True, encoding="utf-8")
        self.queue = SimpleQueue()
        self.unmatched = deque()
        self.sequence = 100
        self.sent, self.received = [], []
        self.reading = Thread(target=self.read, daemon=True)
        self.reading.start()

    def read(self):
        for line in self.child.stdout:
            self.queue.put(line)
        self.queue.put(None)

    def __enter__(self):
        return self

    def __exit__(self, _, error, __):
        if not self.child.stdin.closed:
            self.child.stdin.close()
        try:
            status = self.child.wait(timeout=15)
            if status and error is None:
                raise AssertionError(f"Host bridge exited with status {status}")
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()
            if error is None:
                raise
        finally:
            self.reading.join()
            self.child.stdout.close()

    def send(self, identifier, method, **params):
        request = {"id": identifier, "method": method, "params": params}
        self.sent.append(request)
        self.child.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.child.stdin.flush()

    def receive(self, matches, timeout=5):
        for frame in self.unmatched:
            if matches(frame):
                self.unmatched.remove(frame)
                return frame
        deadline = monotonic() + timeout
        while True:
            text = self.queue.get(timeout=max(0, deadline - monotonic()))
            if text is None:
                raise AssertionError("Runtime closed the connection before returning the frame")
            frame = json.loads(text)
            self.received.append(frame)
            if matches(frame):
                return frame
            self.unmatched.append(frame)

    def reply(self, identifier, timeout=5):
        return self.receive(lambda frame: "id" in frame and frame["id"] == identifier, timeout)

    def request(self, method, **params):
        self.sequence += 1
        self.send(self.sequence, method, **params)
        return self.reply(self.sequence)

    def call(self, method, **params):
        frame = self.request(method, **params)
        assert set(frame) == {"id", "result"}, frame
        return frame["result"]

    def trace(self):
        return {"sent": self.sent, "received": self.received}


def wait_file(file):
    until = monotonic() + 5
    while not file.exists():
        assert monotonic() < until, f"Fixture did not create {file.name}"
        sleep(0.01)


def initialize(host, *, required=(), optional=()):
    return host.call("initialize", protocol=PROTOCOL, majorVersion=1,
                     capabilities={"required": list(required), "optional": list(optional)})


def new_data(folder):
    folder.mkdir()
    (folder / "A.txt").write_bytes(VECTORS["source"].encode())
    (folder / "B.txt").write_text("Original B", encoding="utf-8")
    return folder


def open_app(host, app_path, installation, folder):
    host.call("registerApp", installationId=installation, localPath=str(app_path), config={"folder": str(folder)})
    return host.call("openApp", installationId=installation)


def prepare(host, scope, app):
    result = host.call("observe", scopeId=scope, app=app["app"])
    assert result["status"] == "prepared", result
    return result


def mount(candidate, name):
    return next(view for view in candidate["observation"]["views"] if view["name"] == name)


def present(host, scope, layout, catalog):
    return host.call("presentTurn", scopeId=scope, apps=[
        {"candidate": candidate["candidate"], "views": [
            {"viewInstanceId": view["viewInstanceId"], **choices[view["id"]]}
            for view in candidate["observation"]["views"] if view["id"] in choices
        ]}
        for candidate, choices in layout
    ], catalog=catalog, capabilities=CAPABILITIES)


def adopt(host, scope, presentation):
    result = host.call("adoptTurn", scopeId=scope, presentation=presentation["presentation"])
    assert result["status"] == "adopted", result
    assert result["cleanupIssues"] == []
    assert host.call("discardScope", scopeId=scope) == {"cleanupIssues": []}
    return result["turn"]


def route(app, turn, view, invocation, **args):
    return {"turn": turn, "name": f"{app['appId']}-edit", "invocationId": invocation,
            "input": {"view_id": view["id"], **args}}


def wire_view(presented, app, view):
    return next(item for item in presented["views"] if item["appId"] == app["appId"] and item["viewId"] == view["id"])


def version_errors(executable):
    with Host(executable) as host:
        before = host.request("desktop")
        wrong_identity = host.request("initialize", protocol="aotui-app", majorVersion=1)
        wrong_version = host.request("initialize", protocol=PROTOCOL, majorVersion=77)
        required = host.request("initialize", protocol=PROTOCOL, majorVersion=1,
                                capabilities={"required": ["future-required"]})
        for frame in (before, wrong_identity, wrong_version, required):
            assert frame["error"]["code"] == "PROTOCOL_UNSUPPORTED", frame
        assert "aotui-app" in wrong_identity["error"]["message"]
        assert "77" in wrong_version["error"]["message"] and "major 1" in wrong_version["error"]["message"]
        assert "future-required" in required["error"]["message"]
        hello = initialize(host, optional=["future-optional"])
        assert hello == {"protocol": PROTOCOL, "majorVersion": 1, "capabilities": []}, hello
        assert host.request("subscribeOutput", apps=[])["error"]["code"] == "PROTOCOL_UNSUPPORTED"
        assert host.call("listApps") == []
        return host.trace()


def baseline(executable, app_path, work):
    alpha_files, beta_files = new_data(work / "alpha"), new_data(work / "beta")
    with Host(executable) as host:
        assert initialize(host)["capabilities"] == []
        alpha = open_app(host, app_path, "alpha", alpha_files)
        beta = open_app(host, app_path, "beta_hidden", beta_files)
        scope = host.call("beginCandidateScope")["scopeId"]
        a, hidden = prepare(host, scope, alpha), prepare(host, scope, beta)
        first, second = mount(a, "A.txt"), mount(a, "B.txt")
        assert first["id"] == "A_1"
        body = present(host, scope, [(a, {}), (hidden, {})], ["alpha"])
        hint = present(host, scope, [(a, {first["id"]: {"kind": "hint"}})], ["alpha"])
        folded = present(host, scope, [(a, {first["id"]: {"kind": "collapsed", "note": "hold <&>\rend"}})], ["alpha"])
        assert all(not response["issues"] for response in (body, hint, folded))
        assert len(body["apps"]) == 1 and "beta_hidden" not in body["desktop"]
        assert {view["appId"] for view in body["views"]} == {alpha["appId"]}
        index = next(view for view in body["views"] if view["region"] == "static")
        assert index["content"] == VECTORS["indexXml"]
        unescaped = wire_view(body, alpha, first)["content"]
        assert unescaped == VECTORS["fileXml"]
        assert fromstring(unescaped).text.startswith("\n" + VECTORS["source"])
        assert wire_view(hint, alpha, first)["content"] == VECTORS["hintXml"]
        assert wire_view(folded, alpha, first)["content"] == VECTORS["collapsedXml"]
        assert first["id"] not in [entry["viewId"] for entry in hint["apps"][0]["windows"]["activeViews"]]
        edit = next(tool for tool in hint["tools"] if tool["name"] == f"{alpha['appId']}-edit")
        assert edit["schema"] == VECTORS["editSchema"]

        # The final presentation must be re-measured and adopted, never a previous trial.
        trial = host.request("adoptTurn", scopeId=scope, presentation=body["presentation"])
        assert trial["error"]["code"] == "PRESENTATION_UNAVAILABLE"
        final = present(host, scope, [(a, {first["id"]: {"kind": "hint"}})], ["alpha"])
        turn = adopt(host, scope, final)
        denied = host.call("invokeNative", **route(alpha, turn, first, "hinted", text="no write"))
        assert denied["receipt"]["executionPhase"] == "not-dispatched"
        source = f"$ref.{alpha['appId']}.{first['id']}.people[0][\"display.name\"]"
        assert host.call("inspectRef", turn=turn, address=source, mode="value")["status"] == "rejected"
        accepted = host.call("invokeNative", **route(alpha, turn, second, "write-b", text="Only B changed"))
        assert accepted["receipt"]["executionPhase"] == "entered-returned"
        assert host.call("readDesktopReceipt", **accepted["locator"])["receipt"] == accepted["receipt"]
        assert (alpha_files / "A.txt").read_bytes() == VECTORS["source"].encode()
        assert (alpha_files / "B.txt").read_text() == "Only B changed"
        scope = host.call("beginCandidateScope")["scopeId"]
        prepare(host, scope, beta)  # The discarded, filtered candidate gave up its only spare slot.
        a2 = prepare(host, scope, alpha)
        restored = present(host, scope, [(a2, {})], ["alpha"])
        turn2 = adopt(host, scope, restored)
        assert host.call("inspectRef", turn=turn2, address=source, mode="value") == {"status": "ready", "value": VECTORS["nameAtPath"]}
        assert "Only B changed" in wire_view(restored, alpha, second)["content"]
        shutdown = host.call("shutdown")
        assert shutdown["ok"] and shutdown["resourcesReleased"] and shutdown["workers"]["report"]["total"] == 0
        return {"stable": {"indexXml": index["content"], "fileXml": unescaped, "hintXml": VECTORS["hintXml"],
                           "collapsedXml": VECTORS["collapsedXml"], "editSchema": edit["schema"],
                           "writeOutcome": accepted["receipt"]["outcome"], "readValue": VECTORS["nameAtPath"]},
                "wire": host.trace(), "shutdown": shutdown}


def asynchronous(executable, app_path, work):
    alpha_files, beta_files = new_data(work / "alpha"), new_data(work / "beta")
    with Host(executable) as host:
        assert initialize(host, required=["output-events"])["capabilities"] == ["output-events"]
        alpha = open_app(host, app_path, "alpha", alpha_files)
        beta = open_app(host, app_path, "beta", beta_files)
        assert host.call("subscribeOutput", apps=[alpha["app"]]) is None
        (beta_files / "attention").touch()
        wait_file(beta_files / "attention-sent")
        (alpha_files / "attention").touch()
        event = host.receive(lambda frame: frame.get("signal", {}).get("reason") == "attention_requested")
        assert "id" not in event and event["event"] == "output"
        assert event["signal"]["instanceId"] == alpha["instanceId"]
        assert event["signal"]["appId"] == alpha["appId"]
        scope = host.call("beginCandidateScope")["scopeId"]
        a, b = prepare(host, scope, alpha), prepare(host, scope, beta)
        first, other = mount(a, "A.txt"), mount(b, "B.txt")
        turn = adopt(host, scope, present(host, scope, [(a, {}), (b, {})], ["alpha", "beta"]))

        host.send(42, "invokeNative", **route(alpha, turn, first, "slow-a", text="A settled", wait=True))
        wait_file(alpha_files / "edit-entered")
        host.send(42, "desktop")
        host.send("42", "revokeWindowAccess", turn=turn, app=beta["app"],
                  viewId=other["id"], viewInstanceId=other["viewInstanceId"])
        assert host.reply("42", 2)["result"] is None
        assert host.reply(None)["error"]["code"] == "REQUEST_ID_IN_USE"
        assert not any(frame.get("id") == 42 for frame in host.received)
        busy = host.call("invokeNative", **route(alpha, turn, first, "parallel-a", text="no write"))
        assert busy["kind"] == "refused" and busy["code"] == "INVOCATION_CAPACITY", busy
        denied = host.call("invokeNative", **route(beta, turn, other, "revoked-b", text="no write"))
        assert denied["receipt"]["executionPhase"] == "not-dispatched"
        address = f"$ref.{beta['appId']}.{other['id']}.content"
        assert host.call("inspectRef", turn=turn, address=address, mode="value")["status"] == "rejected"
        (alpha_files / "edit-release").touch()
        slow = host.reply(42)["result"]
        assert slow["receipt"]["outcome"]["status"] == "succeeded"
        assert host.call("readDesktopReceipt", **slow["locator"])["receipt"] == slow["receipt"]
        assert (alpha_files / "A.txt").read_text() == "A settled"
        assert json.loads((alpha_files / "writes.jsonl").read_text()) == {"name": "A.txt", "text": "A settled"}
        assert (beta_files / "B.txt").read_text() == "Original B"

        late_scope = host.call("beginCandidateScope")["scopeId"]
        (alpha_files / "projection-hold").touch()
        wait_file(alpha_files / "projection-entered")
        host.send("late", "observe", scopeId=late_scope, app=alpha["app"])
        host.send("discard", "discardScope", scopeId=late_scope)
        assert host.reply("discard", 2)["result"] == {"cleanupIssues": []}
        assert not any(frame.get("id") == "late" for frame in host.received)
        (alpha_files / "projection-release").touch()
        assert host.reply("late")["result"]["issue"]["code"] == "CANDIDATE_SCOPE_CLOSED"
        scope = host.call("beginCandidateScope")["scopeId"]
        prepare(host, scope, alpha)
        assert host.call("discardScope", scopeId=scope) == {"cleanupIssues": []}

        (beta_files / "close-hold").touch()
        host.send("close-first", "closeApp", app=beta["app"])
        wait_file(beta_files / "close-entered")
        host.send("close-second", "closeApp", app=beta["app"])
        assert host.call("desktop")["id"]
        (beta_files / "close-release").touch()
        first_close = host.reply("close-first")["result"]
        second_close = host.reply("close-second")["result"]
        assert first_close == second_close and first_close["resourcesReleased"]

        shutdown = host.call("shutdown")
        assert shutdown["ok"] and shutdown["resourcesReleased"] and shutdown["workers"]["report"]["total"] == 0
        assert sum(frame.get("id") == 42 for frame in host.received) == 1
        return {"wire": host.trace(), "idleAttention": event, "busy": busy, "revoked": denied, "slow": slow,
                "concurrentClose": first_close, "shutdown": shutdown}


def eof(executable, app_path, work):
    folder = new_data(work / "alpha")
    with Host(executable) as host:
        initialize(host, required=["output-events"])
        alpha = open_app(host, app_path, "alpha", folder)
        host.call("subscribeOutput", apps=[alpha["app"]])
        scope = host.call("beginCandidateScope")["scopeId"]
        a = prepare(host, scope, alpha)
        first = mount(a, "A.txt")
        turn = adopt(host, scope, present(host, scope, [(a, {})], ["alpha"]))
        unadopted = host.call("beginCandidateScope")["scopeId"]
        prepare(host, unadopted, alpha)
        host.send("write", "invokeNative", **route(alpha, turn, first, "slow-eof", text="EOF preserved", wait=True))
        wait_file(folder / "edit-entered")
        host.child.stdin.close()
        (folder / "edit-release").touch()
        assert host.child.wait(timeout=10) == 0
        wait_file(folder / "close-finished")
        assert (folder / "A.txt").read_text() == "EOF preserved"
        assert json.loads((folder / "writes.jsonl").read_text()) == {"name": "A.txt", "text": "EOF preserved"}
        return {"exit": host.child.returncode, "appCleanup": True, "landed": (folder / "A.txt").read_text()}

def broken_output(executable, app_path, work):
    folder = new_data(work / "alpha")
    with subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          text=True, encoding="utf-8") as child:
        def send(identifier, method, **params):
            child.stdin.write(json.dumps({"id": identifier, "method": method, "params": params}) + "\n")
            child.stdin.flush()
        try:
            for identifier, method, params in (
                (1, "initialize", {"protocol": PROTOCOL, "majorVersion": 1}),
                (2, "registerApp", {"installationId": "alpha", "localPath": str(app_path),
                                    "config": {"folder": str(folder)}}),
                (3, "openApp", {"installationId": "alpha"}),
            ):
                send(identifier, method, **params)
                assert select([child.stdout], [], [], 5)[0]
                reply = json.loads(child.stdout.readline())
                assert reply["id"] == identifier and "result" in reply
            child.stdout.close()
            send(4, "desktop")
            assert child.wait(timeout=10) == 0
            assert (folder / "close-finished").exists()
            return {"exit": child.returncode, "appCleanup": True}
        finally:
            if child.poll() is None:
                child.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bridge", type=Path)
    parser.add_argument("app", type=Path)
    args = parser.parse_args()
    exe, app = args.bridge.resolve(), args.app.resolve()
    print_data = {"diagnostics": version_errors(exe)}
    for name, check in (("baseline", baseline), ("asynchronous", asynchronous),
                        ("eof", eof), ("brokenOutput", broken_output)):
        with TemporaryDirectory(prefix="aotui-frozen-host-") as temp:
            print_data[name] = check(exe, app, Path(temp))
    print_data["fixtureSha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                  for path in (Path(__file__), Path(__file__).with_name("vectors.json"),
                                               app / "aoapp.json", app / "app.mjs")}
    print(json.dumps(print_data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
