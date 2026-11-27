"""Measure reference clips and studio WAVs at a common bandwidth. Run from the repo root."""
import argparse
import csv
import json
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

from reference_articulation import recorded_formants
from reference_fit import Analysis, alignment, split_recording

RATE = 16000
WORDS = ["부","푸","뿌","불","풀","뿔"]
VOICES = ["male","female","child"]

def read(path):
    fs, y = wavfile.read(path)
    return signal.resample_poly(y.astype(float)/32768, RATE, fs)

def window(y, a, b):
    return y[max(0,round(a*RATE)):max(0,round(b*RATE))]

def rms(y):
    return float(np.sqrt(np.mean(y*y))) if len(y) else 0.

def db(x):
    return 20*np.log10(max(1e-9,x))

def median(values):
    return float(np.median(values)) if len(values) else None

def pitch(a, lo, hi):
    return median(a.hz[(a.t>=lo)&(a.t<hi)&(a.hz>0)])

def cue(y, meta):
    offset=0.
    probe={}
    hint=None
    flags=[]
    if meta:
        seg=meta["segments"]
        i=next(i for i,s in enumerate(seg[:-1]) if s["ipa"] in ("p","b") and seg[i+1]["ipa"]=="u")
        stop=seg[i]
        p=np.array(meta["probe"])
        candidates=np.where((p[:-1,1]<=.02)&(p[1:,1]>.02))[0]+1
        candidates=[k for k in candidates if abs(p[k,0]-stop["end"])<=.045]
        if candidates:
            k=min(candidates,key=lambda k:abs(p[k,0]-stop["end"]))
            pre=p[(p[:,0]>=p[k,0]-.031)&(p[:,0]<p[k,0])]
            probe=dict(lipOpenMs=p[k,0]*1000,prePressurePa=median(pre[:,3]),preScopeMeanCm2=median(pre[:,5]))
        else: flags.append("no-lip-crossing")
        probe["plannedMs"]=1000*stop["end"]
        if i:
            # Exclude other syllables. Only the search anchor is supplied by the plan.
            offset=max(0,stop["start"]+.010)
            y=window(y,offset,seg[i+1]["end"]+.025)
            hint=stop["end"]-offset
    a=Analysis(y,RATE,hint,require_onset=False)
    # Use identical peak-of-1ms high-band attack around the detected event for every source.
    high=signal.sosfilt(signal.butter(3,1100,fs=RATE,btype="highpass",output="sos"),y)
    anchor=(probe.get("lipOpenMs",probe.get("plannedMs",0))/1000-offset) if meta else a.burst
    # The search anchor comes from oral opening in the model and first audible attack on tape.
    # The actual burst, levels and periodicity are picked identically from band-limited PCM.
    starts=np.arange(max(0,round((anchor-.012)*RATE)),min(len(y)-16,round((anchor+.008)*RATE)))
    power=np.convolve(high**2,np.ones(16)/16,mode="valid")
    burst=(starts[np.argmax(power[starts])]+8)/RATE
    typical=median(a.hz[(a.hz>0)&(a.db>-18)]) or median(a.hz[a.hz>0])
    good=(a.hz>typical*.56)&(a.hz<typical*1.8)
    period=next((k for k in range(len(good)-5) if a.t[k]>=burst-.002 and all(good[k:k+6])),None)
    if period is None:
        return dict(**probe,flags="no-sustained-voicing")
    a.onset=a.t[period]
    a.vot=max(0.,a.onset-burst)
    if abs(a.burst-burst)>.025: flags.append("earlier-attack-possible")
    vowel=window(y,a.onset+.040,a.onset+.085)
    v=rms(vowel)
    peak=max((rms(window(high,burst+j/1000,burst+(j+1)/1000)) for j in range(-1,4)),default=0.)
    breath=window(high,burst+.003,min(a.onset,burst+.080))
    early=pitch(a,a.onset+.010,a.onset+.040)
    steady=pitch(a,a.onset+.050,a.onset+.090)
    hz=early
    h12=None
    if hz:
        y0=window(y,a.onset+.008,a.onset+.040)
        phase=2*np.pi*hz*np.arange(len(y0))/RATE
        m=np.column_stack([np.cos(phase),np.sin(phase),np.cos(2*phase),np.sin(2*phase),np.ones(len(y0))])
        win=np.hanning(len(y0))
        coef=np.linalg.lstsq(m*win[:,None],y0*win,rcond=None)[0]
        h12=db(np.hypot(*coef[:2]))-db(np.hypot(*coef[2:4]))
    if len(breath)<.004*RATE: flags.append("aspiration-too-short")
    if a.vot<.005: flags.append("VOT-within-5ms-hop")
    if probe.get("lipOpenMs") and abs((burst+offset)*1000-probe["lipOpenMs"])>20: flags.append("burst/geometry-disagree")
    return dict(**probe,burstMs=(offset+burst)*1000,voiceMs=(offset+a.onset)*1000,votMs=a.vot*1000,
        preDb=db(rms(window(y,burst-.140,burst-.055)))-db(v),burstDb=db(peak)-db(v),breathDb=db(rms(breath))-db(v) if len(breath)>=.004*RATE else None,
        onsetHz=early,steadyHz=steady,onsetSt=12*np.log2(early/steady) if early and steady else None,h1h2Db=h12,
        flags="|".join(flags))

def save(file,rows):
    keys=list(dict.fromkeys(k for r in rows for k in r))
    with file.open("w",encoding="utf-8-sig",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=keys)
        writer.writeheader()
        writer.writerows([{k:round(v,4) if isinstance(v,(float,np.floating)) else v for k,v in row.items()} for row in rows])

def syllables(y, ref, seg):
    a=Analysis(y,RATE,require_onset=False)
    at,bt,_=alignment(a,ref)
    bounds=[max(a.start,seg[0]["start"])] + [s["end"] for s in seg if s["kind"]=="vowel"]
    bounds[-1]=a.end
    # Map interior boundaries only, keeping observed speech start/end for both takes.
    rb=[ref.start]+[float(np.median(bt[np.abs(at-v)==np.min(abs(at-v))])) for v in bounds[1:-1]]+[ref.end]
    result=[]
    for i,(s,letter) in enumerate(zip([s for s in seg if s["kind"]=="vowel"],"가치머거")):
        mask=(a.t>=s["start"]+.12*(s["end"]-s["start"]))&(a.t<=s["end"]-.12*(s["end"]-s["start"]))&(a.hz>0)
        vt=a.t[mask]
        rvt=np.unique(np.interp(vt,at,bt)) if len(vt) else []
        row={"syllable":letter,"ipa":s["ipa"]}
        for prefix,b,bs,ts in [("model",a,bounds,vt),("ref",ref,rb,rvt)]:
            ts=np.array(ts); lo,hi=bs[i:i+2]
            ff=recorded_formants(b,ts) if len(ts) else None
            f0=pitch(b,lo,hi)
            q0,q1=(pitch(b,lo+(hi-lo)*j,lo+(hi-lo)*k) for j,k in [(.2,.5),(.65,.95)])
            row.update({prefix+"Ms":1000*(hi-lo),prefix+"F0":f0,prefix+"F1":ff[0] if ff else None,
              prefix+"F2":ff[1] if ff else None,prefix+"SlopeSt":12*np.log2(q1/q0) if q0 and q1 else None})
        result.append(row)
    return result

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("root",type=Path); ap.add_argument("recordings",type=Path)
    ap.add_argument("variant");ap.add_argument("split",choices=["development","holdout"])
    args=ap.parse_args();root=args.root;variant=args.variant
    rows=[]; prosody=[]
    for voice, filename in zip(VOICES,["speech.wav","speech_여성.wav","speech_아동.wav"]):
        reference=split_recording(args.recordings/filename)
        for i,(samples,fs,_) in enumerate(reference[:6]):
            word=WORDS[i]
            if args.split=="development":
                original=signal.resample_poly(samples,RATE,fs)
                rows.append(dict(voice=voice,context="recording",word=word,**cue(original,None)))
            for ctx in (["word","dev"] if args.split=="development" else ["test"]):
                base=root/variant/(voice+"-"+ctx+str(i))
                meta=json.loads(base.with_suffix(".json").read_text())
                rows.append(dict(voice=voice,context=ctx,word=word,**cue(read(base.with_suffix(".wav")),meta)))
        if args.split=="development":
            base=root/variant/(voice+"-question")
            samples,fs,_=reference[-1]
            ref=Analysis(signal.resample_poly(samples,RATE,fs),RATE)
            seg=json.loads(base.with_suffix(".json").read_text())["segments"]
            for row in syllables(read(base.with_suffix(".wav")),ref,seg):
                prosody.append(dict(voice=voice,**row))
    save(root/(variant+"-"+args.split+".csv"),rows)
    if prosody: save(root/(variant+"-prosody.csv"),prosody)

if __name__=="__main__": main()
