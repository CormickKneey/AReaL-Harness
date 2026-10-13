import assert from "node:assert/strict";
// Draft-state integration sequence: external app delivery -> existing owner -> edit/remove -> accepted capture.
const { appendMcpDraft, readMcpDraft, removeMcpDraft, consumeMcpDraft } = await import("../renderer/src/mcp-app-draft.js");
const values = new Map(); const storage = {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
storage.setItem("draft:p:t","existing human draft");
appendMcpDraft("draft:p:t",[{type:"text",text:"new text"},{type:"text",text:"detail",_meta:{"openai/title":"Selection"}},{type:"resource_link",name:"issue",uri:"github://issue/1"}],storage);
assert.equal(storage.getItem("draft:p:t"),"existing human draft\nnew text");
const capture=readMcpDraft("draft:p:t",storage); assert.equal(capture.length,2); assert.equal(capture[0].block._meta["openai/title"],"Selection");
appendMcpDraft("draft:p:t",[{type:"text",text:"newer",_meta:{"openai/title":"Newer selection"}}],storage);
consumeMcpDraft("draft:p:t",capture,storage);assert.equal(readMcpDraft("draft:p:t",storage).length,1);
const newer=readMcpDraft("draft:p:t",storage)[0];removeMcpDraft("draft:p:t",newer.id,storage);assert.equal(readMcpDraft("draft:p:t",storage).length,0);
assert.equal(readMcpDraft("draft:p:other",storage).length,0);
console.log("MCP Apps draft-owner integration passed.");
