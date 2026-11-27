"""Test-only D3 JSONL peer. No dependency on the production raw v1 bridge."""
import json
import sys

APP, INSTANCE = "d3", "d3-run"
SCHEMA = int(sys.argv[1])
current = None
pending = None
stopped = False
faulted = False
seq = 0
entries = 0
closes = 0
tool_id = json.dumps([APP, "Reader", "read"], separators=(",", ":"))
ref_key = json.dumps(["file", "m:1", "selected"], separators=(",", ":"))


def send(**message):
    print(json.dumps(message, separators=(",", ":"), allow_nan=False), flush=True)


def stamp(frame):
    return {k: frame["draft"][k] for k in ("appId", "instanceId", "producerSeq", "sourceEpoch")}


def build(req):
    global seq
    epoch = 1 if current is None else current["draft"]["sourceEpoch"] + 1
    seq += 1
    scope = req.get("scope", "public")
    previous = None if current is None or faulted else current["continuity"].get(ref_key)
    old = previous or [0, 0, 0]
    continuity = [old[0] or epoch, (old[1] or epoch) if scope != "private" else 0,
                  (old[2] or epoch) if scope == "public" else 0]
    view = {"id": "file", "viewInstanceId": "m:1", "type": "File", "name": "File",
            "region": "dynamic", "content": {"format": "markdown-v1", "value": req["value"]},
            "toolBindings": []}
    reader = {"id": "reader", "viewInstanceId": "m:2", "type": "Reader", "name": "Reader",
              "region": "dynamic", "content": {"format": "markdown-v1", "value": "Read selected"},
              "toolBindings": [{"toolId": tool_id, "activationId": "a:" + str(2 * req.get("activation", 1) - 1)}],
              "closeActivationId": "a:" + str(2 * req.get("activation", 1))}
    views = [view, reader]
    if req.get("overCapacity"):
        views.append({"id": "overflow", "viewInstanceId": "m:3", "type": "Extra", "name": "Extra",
                      "region": "dynamic", "content": {"format": "markdown-v1", "value": "extra"},
                      "toolBindings": []})
    return {
        "draft": {"schemaVersion": SCHEMA, "appId": APP, "instanceId": INSTANCE,
                  "producerSeq": seq, "sourceEpoch": epoch, "healthySince": epoch if current is None or faulted else current["healthySince"], "capturedAt": epoch,
                  "views": views, "refs": {ref_key: {"id": "selected", "ownerViewId": "file",
                  "ownerViewInstanceId": "m:1", "refType": "Text", "scope": scope, "continuity": continuity,
                  "valueSchema": {"type": "string"}, "target": {"kind": "snapshot-value", "payload": req["value"]}}},
                  "tools": {tool_id: {"id": tool_id, "name": "read", "viewType": "Reader",
                  "multiplicity": "single", "description": "Read selected text",
                  "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                                  "required": ["text"], "additionalProperties": False}}}},
        "healthySince": epoch if current is None or faulted else current["healthySince"],
        "continuity": {ref_key: continuity},
        "closeActivation": "a:" + str(2 * req.get("activation", 1)),
    }


def done(req_id, kind, frame=None):
    if stopped or faulted or frame is None:
        send(type="reply", id=req_id, kind=kind, status="failed", code="APP_STOPPED" if stopped else "SNAPSHOT_UNREADY")
    else:
        send(type="reply", id=req_id, kind=kind, status="done", publication=stamp(frame))


for line in sys.stdin:
    req = json.loads(line)
    kind = req["type"]
    if kind == "exit":
        break
    if kind == "publish":
        mode = req.get("mode", "authoritative")
        if stopped or (mode == "candidate" and faulted) or pending is not None:
            send(type="reply", id=req["requestId"], kind=req["kind"], status="failed",
                 code="APP_STOPPED" if stopped else "SNAPSHOT_UNREADY")
            continue
        frame = build(req)
        if mode == "authoritative":
            current = frame
            faulted = False
        else:
            pending = (req, frame)
        # Authoritative: local installation precedes publish and done. Never wait for an ACK.
        send(type="publish", id=req["id"], requestId=req["requestId"], kind=req["kind"], mode=mode, **frame)
        if mode == "authoritative":
            done(req["requestId"], req["kind"], current)
    elif kind == "publishResult":
        if pending is None:
            continue
        original, candidate = pending
        if req["id"] != original["id"] or req.get("publication") != stamp(candidate):
            continue
        pending = None
        if req["status"] == "accepted" and not stopped and not faulted:
            current = candidate
            done(original["requestId"], original["kind"], current)
        else:
            send(type="reply", id=original["requestId"], kind=original["kind"], status="failed",
                 code="APP_STOPPED" if stopped else "CANDIDATE_REJECTED")
    elif kind == "observe":
        done(req["id"], "observe", current)
    elif kind == "staleReply":
        send(type="reply", id=req["id"], kind=req["kind"], status="done", publication=req["publication"])
    elif kind == "fault":
        faulted = True
        seq += 1
        send(type="fault", appId=APP, instanceId=INSTANCE, producerSeq=seq,
             sourceEpoch=current["draft"]["sourceEpoch"], issue={"code": "SNAPSHOT_INVALID", "path": "$.build", "message": "fault"})
    elif kind == "stop":
        stopped = True
        send(type="stopped", id=req["id"])
    elif kind in ("invoke", "closeView"):
        source = req["receiver"]
        live = not stopped and not faulted and current is not None
        if live:
            view = current["draft"]["views"][1]
            activation = current["closeActivation"] if kind == "closeView" else view["toolBindings"][0]["activationId"]
            live = source == {"viewId": view["id"], "viewInstanceId": view["viewInstanceId"], "activationId": activation}
            for ref in req.get("localRefs", []):
                key = json.dumps([ref["viewId"], ref["viewInstanceId"], ref["refId"]], separators=(",", ":"))
                lane = 0 if ref["viewInstanceId"] == source["viewInstanceId"] else 1
                starts = current["continuity"].get(key)
                live = live and starts is not None and starts[lane] != 0 and starts[lane] == ref["since"]
        if live:
            entries += kind == "invoke"
            closes += kind == "closeView"
        send(type="business", id=req["id"], phase="entered-returned" if live else "not-entered",
             entries=entries, closes=closes, value=req.get("input", {}).get("text") if live else None)
    elif kind == "inspect":
        send(type="state", id=req["id"], current=current, pending=pending is not None,
             stopped=stopped, faulted=faulted, entries=entries, closes=closes)
