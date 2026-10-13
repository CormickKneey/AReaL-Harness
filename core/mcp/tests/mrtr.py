# External stdio protocol fixture; records wire requests, never Core internals.
import sys,json,os,urllib.parse,time
for line in sys.stdin:
 r=json.loads(line);m=r.get('method');p=r.get('params',{})
 if 'id' not in r:continue
 if os.environ.get('TRACE'):
  with open(os.environ['TRACE'],'a') as f:f.write(json.dumps(r)+'\n')
 if m=='server/discover':out={'resultType':'complete','supportedVersions':['2026-07-28'],'capabilities':{'tools':{},'resources':{}},'ttlMs':0,'cacheScope':'private'}
 elif m=='tools/list':out={'tools':[{'name':'app','inputSchema':{'type':'object'},'annotations':{'readOnlyHint':True},'_meta':{'ui':{'resourceUri':'ui://app','visibility':['app']}}}]}
 elif m in ['tools/call','resources/read']:
  args=p.get('arguments',{});stage=p.get('requestState');mode=args.get('mode','normal')
  if m=='tools/call' and mode.startswith('marker'):
   out={'isError':mode!='markerSuccess','content':[{'type':'text','text':'provider result'}],'_meta':{'mcp/www_authenticate':['Bearer resource_metadata="https://example.invalid/private-metadata", scope="read"'] if mode!='markerMalformed' else 7,'preserved':True}}
  elif m=='resources/read' and p.get('uri')=='ui://app' and not os.environ.get('READ_FORM'):out={'contents':[{'uri':'ui://app','mimeType':'text/html;profile=mcp-app','text':'<p>MRTR</p>'}]}
  elif stage is None:
   schema={'type':'object','properties':{'answer':{'type':'string'}},'required':['answer']}
   if mode=='upload':schema={'type':'object','properties':{'selected':{'type':'string','format':'uri','x-openai-input':{'type':'resource','options':[],'userOptions':{'kind':'directory','accept':['.txt']}}}},'required':['selected']}
   if mode=='unsupported':schema={'type':'object','properties':{'nested':{'type':'object'}}}
   out={'resultType':'input_required','requestState':'opaque-first','inputRequests':{'first':{'method':'elicitation/create','params':{'mode':'form','message':'First form','requestedSchema':{'type':'object','properties':{}},'_meta':{'openai/elicitation':{'requestedSchema':schema}}}}}}
  elif stage=='opaque-first' and mode=='upload':
   uri=p['inputResponses']['first']['content']['selected'];path=urllib.parse.unquote(urllib.parse.urlparse(uri).path)
   with open(os.path.join(path,'data.txt')) as f:content=f.read()
   out={'content':[{'type':'text','text':json.dumps({'fileUri':uri,'snapshot':content})}]}
  elif stage=='opaque-first' and mode=='timeout':time.sleep(30);out={}
  elif stage=='opaque-first' and mode=='disconnect':sys.exit(0)
  elif stage=='opaque-first' and mode=='normal':out={'resultType':'input_required','requestState':'opaque-second','inputRequests':{'second':{'method':'elicitation/create','params':{'mode':'form','message':'Second form','requestedSchema':{'type':'object','properties':{}},'_meta':{'openai/elicitation':{'requestedSchema':{'type':'object','properties':{'answer':{'type':'string'}}}}}}}}}
  else:out={'content':[{'type':'text','text':json.dumps(p.get('inputResponses'))}],'_meta':{'preserved':True}} if m=='tools/call' else {'contents':[{'uri':p['uri'],'mimeType':'text/html;profile=mcp-app','text':'<p>MRTR finished</p>'}]}
 else:
  print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True);continue
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':out}),flush=True)
