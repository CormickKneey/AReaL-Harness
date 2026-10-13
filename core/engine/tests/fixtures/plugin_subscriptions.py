# Self-owned stdio MCP fixture: wire log and filesystem latch make lifecycle races observable.
import json, os, sys, time
root = os.environ["FIXTURE_ROOT"]
def send(value):
    print(json.dumps(value), flush=True)
def notify(uri):
    send({"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": {"uri": uri}})
for line in sys.stdin:
    q = json.loads(line)
    with open(os.path.join(root, "wire.jsonl"), "a") as log:
        log.write(json.dumps(q) + "\n")
    method, p = q.get("method"), q.get("params", {})
    if "id" not in q:
        continue
    result = {}
    if method == "initialize":
        result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}, "resources": {"subscribe": True}}, "serverInfo": {"name": "subscriptions", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "app", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}, "_meta": {"ui": {"resourceUri": "ui://app", "visibility": ["app"]}}}]}
    elif method == "resources/read":
        if p["uri"].startswith("notify://"):
            notify(p["uri"].replace("notify://", "watch://", 1))
        result = {"contents": [{"uri": p["uri"], "mimeType": "text/html;profile=mcp-app", "text": "<p>Subscriptions</p>"}]}
    elif method == "resources/subscribe":
        if p["uri"] == "watch://slow":
            open(os.path.join(root, "entered"), "w").close()
            while os.path.exists(os.path.join(root, "block")):
                time.sleep(0.005)
        notify(p["uri"])
    elif method == "server/discover":
        send({"jsonrpc": "2.0", "id": q["id"], "error": {"code": -32601, "message": "Method not found"}})
        continue
    send({"jsonrpc": "2.0", "id": q["id"], "result": result})
