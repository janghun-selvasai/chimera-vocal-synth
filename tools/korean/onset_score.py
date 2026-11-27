"""Summarize the locked cue measurements. Distances and classifications are acoustic proxies."""
import argparse
import csv
from pathlib import Path
import numpy as np
from collections import Counter
from onset_measure import save
WORDS=["부","푸","뿌","불","풀","뿔"]
# Same scale for every condition, context and speaker. Interpret in the original units too.
SCALES={"votMs":20,"burstDb":6,"onsetSt":2,"h1h2Db":6}
def load(path):
    with path.open(encoding="utf-8-sig") as f:
        return [{k:(float(v) if k not in ("voice","context","word","flags","syllable","ipa") and v else v) for k,v in r.items()} for r in csv.DictReader(f)]
def err(rows, k): return np.mean([abs(v[k]-r[k]) for v,r in rows if v.get(k,"")!="" and r.get(k,"")!=""])
def classify(c,r):
    available=[k for k in SCALES if c.get(k,"")!="" and all(v.get(k,"")!="" for v in r)]
    if len(available)<3: return "?"
    dist=[np.mean([abs(c[k]-v[k])/SCALES[k] for k in available]) for v in r]
    return r[np.argmin(dist)]["word"]
def main():
    ap=argparse.ArgumentParser();ap.add_argument("root",type=Path);ap.add_argument("split");ap.add_argument("variants",nargs="+");args=ap.parse_args()
    root=args.root
    refs={(r["voice"],r["word"]):r for r in load(root/"baseline-development.csv") if r["context"]=="recording"}
    detail=[];scores=[]; pros=[]
    for var in args.variants:
        rows=load(root/(var+"-"+args.split+".csv"))
        for context in sorted({r["context"] for r in rows}-{"recording"}):
            for voice in ["male","female","child","all"]:
                group=[(r,refs[r["voice"],r["word"]]) for r in rows if r["context"]==context and (voice=="all" or voice==r["voice"])]
                counts=Counter()
                for v,r in group:
                    i=WORDS.index(v["word"])
                    predict=classify(v,[refs[v["voice"],w] for w in WORDS[3*(i//3):3*(i//3)+3]])
                    counts["correct"]+=predict==v["word"]
                    counts["laxToTense"]+=i%3==0 and predict==WORDS[3*(i//3)+2]
                    counts["tenseToLax"]+=i%3==2 and predict==WORDS[3*(i//3)]
                    if voice!="all": detail.append(dict(variant=var,context=context,voice=voice,word=v["word"],acousticNearest=predict))
                scores.append(dict(variant=var,context=context,voice=voice,n=len(group),**counts,
                    **{k+"MAE":err(group,k) for k in [*SCALES,"breathDb","preDb","steadyHz"]}))
        if args.split=="development":
            p=load(root/(var+"-prosody.csv"))
            for voice in ["male","female","child","all"]:
                g=[r for r in p if r["voice"]==voice or voice=="all"]
                row=dict(variant=var,voice=voice)
                for k in ["Ms","F0","F1","F2","SlopeSt"]:
                    pair=[(r["model"+k],r["ref"+k]) for r in g if r["model"+k]!="" and r["ref"+k]!=""]
                    row[k+"MAE"]=np.mean([abs(a-b) for a,b in pair]) if pair else None
                    row[k+"N"]=len(pair)
                pros.append(row)
    save(root/(args.split+"-summary.csv"),scores)
    save(root/(args.split+"-labels.csv"),detail)
    if pros: save(root/"prosody-summary.csv",pros)
if __name__=="__main__":main()
