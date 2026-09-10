import sqlite3,json,pathlib,hashlib
ROOT=pathlib.Path('/tmp/hypaware-cursor-live-probe/home/.cursor/chats/39318caf4103178610e8d4f5926b1f69')
# Minimal wire parser; skip thought payloads before any UTF-8 decode.
def fields(data):
 assert len(data)<1024*1024
 i=0; out={}
 def vi():
  nonlocal i
  val=0
  for shift in range(0,70,7):
   b=data[i];i+=1;val|=(b&127)<<shift
   if b<128:return val
  raise ValueError('varint')
 while i<len(data):
  tag=vi();no=tag>>3;wt=tag&7
  if wt==0: val=vi()
  elif wt==2:
   sz=vi();assert sz<=len(data)-i; val=data[i:i+sz];i+=sz
  elif wt==1:val=data[i:i+8];i+=8
  elif wt==5:val=data[i:i+4];i+=4
  else:raise ValueError('wire')
  out.setdefault(no,[]).append(val)
 return out
def first(f,n,default=b''):return f.get(n,[default])[0]
def txt(f,n):return first(f,n).decode('utf8')
result=[]
for p in sorted(ROOT.glob('*/store.db')):
 db=sqlite3.connect(f'file:{p}?mode=ro&immutable=1',uri=True)
 md=json.loads(bytes.fromhex(db.execute('select value from meta where key=?',('0',)).fetchone()[0]))
 def blob(h):
  h=h.hex() if isinstance(h,bytes) else h
  row=db.execute('select data from blobs where id=?',(h,)).fetchone()
  assert row is not None
  assert hashlib.sha256(row[0]).hexdigest()==h
  return fields(row[0])
 root=blob(md['latestRootBlobId'])
 session={'session_id':md['agentId'],'root_blob_id':md['latestRootBlobId'],'turns':[]}
 for ti,th in enumerate(root.get(8,[])):
  turn=blob(th)
  if 1 not in turn:continue
  at=fields(first(turn,1)); user=blob(first(at,1)); steps=[]
  t={'turn_index':ti,'turn_blob_id':th.hex(),'request_id':txt(at,3),'user_message_id':txt(user,2),'user_text':txt(user,1),'steps':steps}
  for si,sh in enumerate(at.get(2,[])):
   step=blob(sh)
   if 3 in step:
    steps.append({'step_index':si,'kind':'thought_omitted'})
    continue
   row={'step_index':si,'blob_id':sh.hex()}
   if 1 in step:
    a=fields(first(step,1));row.update(kind='assistant',text=txt(a,1),started_at_ms=first(a,2,None),completed_at_ms=first(a,3,None))
   elif 2 in step:
    tool=fields(first(step,2));typ=next((n for n in [1,4,5,8] if n in tool),None)
    row.update(kind='tool',tool_variant=typ,tool_call_id=txt(tool,57),started_at_ms=first(tool,59,None),completed_at_ms=first(tool,60,None))
    if typ:
     body=fields(first(tool,typ));args=fields(first(body,1));res=fields(first(body,2));row.update(result_variant=next(iter(res),None))
     if typ==8:
      row['path']=txt(args,1)
      if 1 in res:
       success=fields(first(res,1));row['content']=txt(success,1);row['content_blob_id']=first(success,10).hex();row['exceeded_limit']=first(success,3,0)
       if row['content_blob_id']:
        h=row['content_blob_id'];b=db.execute('select data from blobs where id=?',(h,)).fetchone();row['content']=b[0].decode('utf8') if b else None
      elif 2 in res:row['error']=txt(fields(first(res,2)),1)
     elif typ==1:
      row['command']=txt(args,1)
      if 4 in res:row['rejection_command']=txt(fields(first(res,4)),1)
     else:
      row['args_field_numbers']=list(args)
      row['result_field_numbers']=list(res)
   steps.append(row)
  session['turns'].append(t)
 result.append(session)
print(json.dumps(result,indent=2))
