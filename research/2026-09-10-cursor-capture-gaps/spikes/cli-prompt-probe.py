from pathlib import Path
exec((Path(__file__).parent / 'cli-store-probe.py').read_text().split('result=[]')[0])
out=[]
for p in sorted(ROOT.glob('*/store.db')):
 db=sqlite3.connect(f'file:{p}?mode=ro&immutable=1',uri=True)
 md=json.loads(bytes.fromhex(db.execute('select value from meta where key=?',('0',)).fetchone()[0]))
 data=db.execute('select data from blobs where id=?',(md['latestRootBlobId'],)).fetchone()[0]
 rf=fields(data);messages=[]
 for ordinal,h in enumerate(rf.get(1,[])):
  # SQL whitelists blocks, so thought strings never enter Python objects or output.
  rows=db.execute('''SELECT json_extract(b.data,'$.role'),json_extract(b.data,'$.id'),
   json_extract(e.value,'$.type'), CASE json_extract(e.value,'$.type')
    WHEN 'text' THEN json_object('type','text','text',json_extract(e.value,'$.text'))
    WHEN 'tool-call' THEN json_object('type','tool-call','toolCallId',json_extract(e.value,'$.toolCallId'),'toolName',json_extract(e.value,'$.toolName'),'args',json_extract(e.value,'$.args'))
    WHEN 'tool-result' THEN json_object('type','tool-result','toolCallId',json_extract(e.value,'$.toolCallId'),'toolName',json_extract(e.value,'$.toolName'),'result',json_extract(e.value,'$.result')) END
   FROM blobs b,json_each(json_extract(b.data,'$.content')) e
   WHERE b.id=? AND json_valid(b.data) AND json_type(b.data,'$.content')='array'
    AND json_extract(b.data,'$.role') IN ('assistant','tool')
    AND json_extract(e.value,'$.type') IN ('text','tool-call','tool-result')''',(h.hex(),)).fetchall()
  if rows:messages.append({'ordinal':ordinal,'blob_id':h.hex(),'role':rows[0][0],'id':rows[0][1],'content':[json.loads(r[3]) for r in rows]})
 out.append({'session_id':p.parent.name,'messages':messages})
print(json.dumps(out,indent=2))
