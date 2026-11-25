import csv,json,time,re,urllib.request,urllib.parse,urllib.error,datetime,pathlib,argparse
import urllib.request,urllib.parse,re,json,pathlib,html
from html.parser import HTMLParser
class Table(HTMLParser):
 def __init__(self):super().__init__();self.rows=[];self.row=[];self.cell=None
 def handle_starttag(self,t,a):
  if t=='tr':self.row=[]
  if t in ('td','th'):self.cell=''
 def handle_data(self,d):
  if self.cell is not None:self.cell+=d
 def handle_endtag(self,t):
  if t in ('td','th') and self.cell is not None:self.row.append(self.cell.strip().lstrip('\ufeff'));self.cell=None
  if t=='tr' and self.row:self.rows.append(self.row)

P=pathlib.Path(__file__).resolve().parent.parent;D=P/'preview_checkpoints';D.mkdir(exist_ok=True)
a=argparse.ArgumentParser();a.add_argument('--limit',type=int,default=100);args=a.parse_args()
rows=list(csv.DictReader(open(P/'welfare_inventory.csv',encoding='utf-8-sig')))
seen=set();todo=[]
for r in sorted(rows,key=lambda r:(not r['scope_tier'].startswith('Core'),r['dataset_id'])):
 pk=r['dataset_id']
 if pk in seen:continue
 seen.add(pk)
 if r['sample_data'] or (D/f'{pk}.json').exists():continue
 if r['catalog_type']!='FILE' or 'csv' not in r['format'].lower():continue
 todo.append(r)
def get(url):
 time.sleep(1.5)
 req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; public-data-research)'})
 with urllib.request.urlopen(req,timeout=30) as q:return q.read().decode('utf-8')
for r in todo[:args.limit]:
 pk=r['dataset_id'];o={'id':pk,'source':r['source_url'],'retrieved_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rows':None,'status':'unavailable'}
 try:
  h=get(r['source_url']);m=re.search(r'fn_fileDataDown\(\s*[\'\"]'+pk+r'[\'\"],\s*[\'\"]([^\'\"]+)',h)
  if not m:o['reason']='No public file download detail key exposed on detail page'
  else:
   url='https://www.data.go.kr/tcs/dss/selectHistAndCsvData.do?'+urllib.parse.urlencode({'publicDataPk':pk,'publicDataDetailPk':m[1]});o['preview_url']=url
   content=get(url); tab=Table();tab.feed(content)
   data=tab.rows
   if len(data)>1:
    hdr=data[0];valid=[x for x in data[1:] if len(x)==len(hdr) and len(x)>1]
    if hdr and valid and hdr != ['데이터명','등록일']:o.update(rows=[hdr]+valid[:3],status='verified',sample_type='official public file preview')
   if o['rows'] is None:o['reason']='No tabular public data preview found; not a fabricated example'
 except urllib.error.HTTPError as e:
  o['reason']='HTTP '+str(e.code)
  (D/f'{pk}.json').write_text(json.dumps(o,ensure_ascii=False,indent=2))
  if e.code in [403,429]:print('STOP restriction',pk,e.code,flush=True);break
 except Exception as e:o['reason']=type(e).__name__+': '+str(e)
 (D/f'{pk}.json').write_text(json.dumps(o,ensure_ascii=False,indent=2));print(pk,o['status'],flush=True)
