"""Build an offline listening set with synthetic minimal pairs and one local question reference."""
import argparse
import base64
import io
import json
from pathlib import Path
import numpy as np
from scipy.io import wavfile
from reference_fit import split_recording

VOICES={"male":"speech.wav","female":"speech_여성.wav","child":"speech_아동.wav"}
WORDS=["부","푸","뿌","불","풀","뿔"]
def encode(rate,y):
    stream=io.BytesIO()
    wavfile.write(stream,rate,y.astype("<i2"))
    return base64.b64encode(stream.getvalue()).decode("ascii")
def read(path):
    fs,pcm=wavfile.read(path)
    return fs,pcm.astype(float)/32768
def match(pair):
    # One fixed level for every trial, across sessions and voices. Keep waveform dynamics intact.
    out=[]
    for fs,y in pair:
        active=np.abs(y)>max(np.max(np.abs(y))*.03,1e-5)
        gain=10**(-25/20)/np.sqrt(np.mean(y[active]**2))
        if np.max(abs(y))*gain>=.98:
            raise ValueError("Listening level exceeds available headroom")
        out.append(encode(fs,np.rint(y*gain*32767)))
    return out
def main():
    ap=argparse.ArgumentParser();ap.add_argument("root",type=Path);ap.add_argument("recordings",type=Path);ap.add_argument("out",type=Path)
    args=ap.parse_args(); page=Path(__file__).with_name("onset-listen.html").read_text(encoding="utf8")
    pack={}
    for voice,filename in VOICES.items():
        rows=[]
        for i,word in enumerate(WORDS):
            # One voice block balances 3 initials × 2 contexts × 2 conditions.
            ctx="word" if i<3 else "test"
            pair=match([read(args.root/v/(voice+"-"+ctx+str(i)+".wav")) for v in ["baseline","studio"]])
            for version,wav in zip(["before","after"],pair):
                rows.append(dict(word=word,ctx=ctx,version=version,wav=wav))
        qs=[read(args.root/v/(voice+"-question.wav")) for v in ["baseline","studio"]]
        human,fs,_=split_recording(args.recordings/filename)[-1]
        # Three independently level-matched question examples, for timbre/rhythm comparison.
        pack[voice]=dict(rows=rows,reference=match([(fs,human)])[0],q=[match([clip])[0] for clip in qs])
    args.out.write_text(page.replace("/*PACK*/{}",json.dumps(pack,ensure_ascii=False)),encoding="utf8")
if __name__=="__main__":main()
