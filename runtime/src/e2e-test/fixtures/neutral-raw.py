"""Real JSONL producer for controlled protocol, seal and startup cases."""
import json
import sys
from pathlib import Path
from time import monotonic, sleep

mode = sys.argv[1]
def send(**packet):
    print(json.dumps(packet, ensure_ascii=False), flush=True)

def reply(id_, status, **data):
    send(type="reply", id=id_, status=status, **data)

hello = json.loads(sys.stdin.readline())
if mode == "late-hello":
    assert json.loads(sys.stdin.readline())["type"] == "release-hello"
send(type="hello", protocol="aotui-app", major=1 if mode == "wrong-protocol" else 2, capabilities=[], requires=[])
original = None
owner = None
for line in sys.stdin:
    req = json.loads(line)
    kind, id_ = req["type"], req.get("id")
    if kind == "initialize":
        owner = req
        if mode == "init-held":
            original = id_
        elif mode in ("init-failed", "long-message", "long-path", "forged"):
            issue = {"code": "PROTOCOL_UNSUPPORTED" if mode == "forged" else "APP_INIT_PROBE", "message": "original init failure", "path": "$.probe"}
            if mode == "long-message":
                issue["message"] = "x" * 2047 + "😀" + "end"
            if mode == "long-path":
                issue["path"] = "$." + "x" * 511
            reply(id_, "failed", issue=issue)
        else:
            reply(id_, "ready")
    elif kind == "open":
        if mode == "open-held":
            original = id_
        else:
            frame = dict(sourceEpoch=1, producerSeq=1, healthySince=1, views=[], refs=[], tools=[])
            stamp = dict(appId=owner["appId"], instanceId=owner["instanceId"], sourceEpoch=1, producerSeq=1)
            send(type="publish", id="frame-1", requestId=id_, mode="authoritative", frame=frame, viewTypes=owner.get("config", {}).get("types", []))
            reply(id_, "done", publication=stamp)
    elif kind == "stop":
        reply(id_, "done", cleanup={"state": "stopped", "issues": []})
        if original:
            if mode == "init-held":
                reply(original, "ready")
            else:
                reply(original, "failed", issue={"code": "APP_STOPPED", "message": "original open stopped"})
            original = None
    elif kind == "close":
        if mode == "close-held":
            folder = Path(owner["config"]["folder"])
            (folder / "cleanup-entered").touch()
            deadline = monotonic() + 5
            while not (folder / "release-cleanup").exists():
                if monotonic() > deadline:
                    raise TimeoutError("test did not release cleanup")
                sleep(.01)
        reply(id_, "done", cleanup={"state": "completed", "issues": []})
        break
    elif kind == "observe":
        send(type="projectionCurrent", id=id_, publication=req.get("known"))
    elif kind == "publishResult":
        pass
