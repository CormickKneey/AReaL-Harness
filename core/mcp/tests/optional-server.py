import json,os,sys,time
log,mode=sys.argv[1:]
def record(value):
 with open(log,"a") as file:file.write(json.dumps(value)+"\n")
record({"pid":os.getpid()})
for line in sys.stdin:
 request=json.loads(line);method=request.get("method");record({"method":method})
 if method=="server/discover":
  print(json.dumps({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Method not found"}}),flush=True);continue
 if method=="initialize":result={"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}
 elif method=="tools/list":
  if mode=="hang":time.sleep(60)
  if mode=="fail":
   print(json.dumps({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"private-provider-secret"}}),flush=True);continue
  result={"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}
 elif method=="tools/call":result={"content":[{"type":"text","text":"alive"}]}
 else:continue
 print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":result}),flush=True)
