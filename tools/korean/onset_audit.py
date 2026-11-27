from pathlib import Path
import argparse
import json
import numpy as np
from scipy.io import wavfile
from onset_measure import save
from onset_score import load as read
parser=argparse.ArgumentParser(description="Audit comparable syllable boundaries and all paired studio WAVs")
parser.add_argument("root",type=Path)
root=parser.parse_args().root
base=read(root/'baseline-prosody.csv'); after=read(root/'ending-prosody.csv')
rows=[]
for a,b in zip(base,after):
 assert a['voice']==b['voice'] and a['syllable']==b['syllable']
 row=dict(voice=a['voice'],syllable=a['syllable'],ipa=a['ipa'])
 for k in ['Ms','F0','F1','F2','SlopeSt']:
  row['reference'+k]=a['ref'+k];row['before'+k]=a['model'+k];row['after'+k]=b['model'+k]
 rows.append(row)
save(root/'fixed-reference-syllables.csv',rows)
results=[]
for v in ['male','female','child','all']:
 group=[r for r in rows if r['voice']==v or v=='all']; x={'voice':v}
 for key in ['Ms','F0','F1','F2','SlopeSt']:
  good=[r for r in group if all(r[f+key]!='' for f in ['before','after','reference'])]
  for phase in ['before','after']:
   x[phase+key]=np.mean([abs(r[phase+key]-r['reference'+key]) for r in good]) if good else None
  x['n'+key]=len(good)
 results.append(x)
save(root/'fixed-reference-errors.csv',results)
checks=[]
for path in sorted((root/'studio').glob('*.json')):
 a,b=[json.loads((root/p/path.name).read_text()) for p in ('baseline','studio')]
 symbols=lambda d:' '.join(s.get('displayIpa') or s['ipa'] for s in d['segments'])
 assert symbols(a)==symbols(b),path.name
 wp=path.with_suffix('.wav')
 ra,ya=wavfile.read(root/'baseline'/wp.name);rb,yb=wavfile.read(wp)
 assert ra==rb==48000 and all(np.max(np.abs(y.astype(int)))<32767 and np.any(y) for y in [ya,yb])
 same=ya.shape==yb.shape and np.array_equal(ya,yb)
 checks.append(dict(id=path.stem,text=b['text'],voice=b['voice'],ipa=symbols(b),beforeSec=len(ya)/ra,afterSec=len(yb)/rb,identicalPCM=same))
assert len(checks)==72
save(root/'render-audit.csv',checks)
print('WAVs unchanged',sum(c['identicalPCM'] for c in checks),'of',len(checks))
for x in results:print(x)
for c in checks:
 if c['id'].startswith('male-extra') or c['id'].endswith('question'):print(c)
