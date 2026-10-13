import sys,json,os
for line in sys.stdin:
 r=json.loads(line);m=r.get("method");p=r.get("params",{});out=None
 if m=="initialize": out={"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":True},"resources":{"subscribe":True}},"serverInfo":{"name":"fixture","version":"1"},"instructions":"keep instructions"}
 elif m=="tools/list":out={"tools":[{"name":"app","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":True},"_meta":{"ui":{"resourceUri":"ui://app","visibility":["app"]}},"icons":[{"src":"https://example.com/icon.png"}]}]}
 elif m=="tools/call" and p.get("arguments",{}).get("form"):
  print(json.dumps({"jsonrpc":"2.0","id":"server-form","method":p["arguments"]["form"],"params":{"mode":"form","message":"Choose","requestedSchema":{"type":"object","properties":{"answer":{"type":"string"}}}}}),flush=True)
  reply=json.loads(sys.stdin.readline());out={"content":[{"type":"text","text":json.dumps(reply)}]}
 elif m=="tools/call":out={"content":[{"type":"text","text":os.environ.get("LITERAL","")}],"_meta":{"secret":"retained"},"structuredContent":{"v":1}}
 elif m=="resources/list":out={"resources":[{"uri":"ui://app","name":"app","mimeType":"text/html;profile=mcp-app"}]}
 elif m=="resources/templates/list":out={"resourceTemplates":[{"uriTemplate":"ui://{name}","name":"app"}]}
 elif m=="resources/read":out={"contents":[{"uri":p["uri"],"mimeType":"text/html;profile=mcp-app","text":"<p>Hello</p>"}]}
 elif m=="resources/subscribe":
  print(json.dumps({"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":p["uri"]}}),flush=True);out={}
 elif m=="resources/unsubscribe":out={}
 if m=="server/discover":
  print(json.dumps({"jsonrpc":"2.0","id":r["id"],"error":{"code":-32601,"message":"Method not found"}}),flush=True);continue
 if "id" in r:print(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":out}),flush=True)
