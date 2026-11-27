# 한국어 표준 발음 50항목

수정 전에는 50개 중 29개(58%), 수정 후에는 50개(100%)에서 합성기의 음소열 전체가 기대값과 일치했다. 기존 정답 29개의 WAV는 SHA-256까지 같았다. 오답이었던 21개에서는 발음 기호와 실제 WAV가 모두 바뀌었다.

| 주된 현상 | 수정 전 | 수정 후 | 고친 수 |
|---|---:|---:|---:|
| 연음 | 9/13 | 13/13 | 4 |
| 겹받침 | 9/12 | 12/12 | 3 |
| 된소리되기 | 3/13 | 13/13 | 10 |
| 비음화 | 8/12 | 12/12 | 4 |

포크에 반영한 합성 엔진은 `873c558`이다. [구현과 회귀 검사](https://github.com/janghun-selvasai/chimera-vocal-synth/commit/873c558565a9b494f2f065de3a6f19fd6ed9b595)

## 표본과 채점

국립국어원 표준 발음법의 용례와 해당 규칙을 적용한 짧은 문장을 골랐다. 띄어쓰기는 이어 읽고, 문장 끝에는 입력의 마침표와 물음표를 유지했다. 한 항목이 여러 규칙에 걸치면 표에는 대표 현상 하나로 집계했다. 표준 한글 발음과 CHIMERA 기호로 옮긴 기대열을 먼저 고정한 뒤 네이티브 CLI를 실행했다. 기대열을 만들 때 합성기를 호출하지 않았다. 기준 엔진은 `a1214b1`, 표본 고정 커밋은 `6e2e7da`다. [고정한 원본](https://github.com/janghun-selvasai/chimera-vocal-synth/blob/6e2e7dad05d1035f0a48153458911c5fa000c69a/docs/korean-speech/standard-50.json)

남성 기본 음색과 `clear` 조건에서 출력 WAV와 최종 타임라인을 함께 저장했다. 모든 음소의 순서와 격음·경음·유성음 표시가 맞아야 한 항목을 정답으로 셌다. 이 점수의 평가 범위는 분절음이다. 모음 장단, 억양, 리듬, 사람의 단어 식별률은 따로 평가해야 한다. 이 50개를 보고 규칙을 조정했으므로 새 문장에 대한 정확도는 아직 측정되지 않았다.

## 어떤 규칙이 바뀌었나

- **연음**. ‘옷이’에서 받침 ㅅ은 그대로 다음 음절로 넘어간다. ‘겉옷’에서 ㅌ은 두 낱말이 만나는 자리에서 대표음 ㄷ으로 바뀐 뒤 이어진다. 합성기에 결합 경계를 알려 주고 그 뒤의 음운 변동을 계산하도록 했다. [표준 발음법 제13~15항](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&pageIndex=1&qna_seq=311699)
- **겹받침**. ‘앉히다’에서 ㄵ의 ㅈ이 ㅎ과 합쳐져 ㅊ이 되고 ㄴ은 받침으로 남는다. ‘넓죽하다·넓적하다’에서는 ㄼ의 ㅂ이 남아 다음 자음을 경음으로 만든다. [제10·12항과 겹받침](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&pageIndex=1&qna_seq=307219) · [‘넓적하다’](https://korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&pageIndex=1&qna_seq=321099)
- **된소리되기**. ‘앉고·더듬지·핥다’처럼 어간 뒤에 어미가 붙을 때, 그리고 ‘할 수 있다’처럼 관형사형 뒤에 의존 명사가 올 때 경음을 계획한다. 피동 접미사가 붙은 ‘안기다’에서는 ㄱ을 평음으로 유지한다. 어간과 결합형의 목록을 사용하므로 동음이의어나 새로운 어휘에는 추가 판단이 필요하다. [제23~27항](https://www.korean.go.kr/front/page/pageView.do?mn_id=72&page_id=P000102)
- **비음화**. ‘꽃잎’에는 두 어근 사이에 ㄴ을 넣은 뒤 앞 받침을 비음으로 바꾼다. ‘생산량’에서는 접미사 ‘량’의 ㄹ이 ㄴ으로 바뀐다. ‘분량’처럼 ㄹ로 읽는 단어도 대조했다. [제18~20·29항](https://www.korean.go.kr/front/page/pageView.do?mn_id=72&page_id=P000102)

## 남은 오류

고정한 50항목의 남은 오답은 0개다. 목록 밖에서 아래 두 오류를 최종 CLI로 재현했다. 다음 검증에서는 처음 보는 합성어와 문맥에 따라 뜻이 바뀌는 동사를 따로 확보할 필요가 있다.

| 입력 | 기대 발음 | 최종 모델에서 관찰한 차이 |
|---|---|---|
| 물약 | [물략] | `m u ɾ j a k`. ㄹ 받침이 빠져 ‘무략’에 해당한다. 어근 ‘물+약’의 경계를 찾지 못한다. |
| 아기를 안다. | ‘안다’의 [안ː따] | 끝부분이 `a n d a`다. 품에 안는 동사와 ‘답을 안다’의 동사를 구별하지 못한다. |

표준 발음은 한국어기초사전의 의미별 항목에서 확인했다. [물약](https://krdict.korean.go.kr/eng/dicSearch/SearchView?ParaWordNo=56456) · [안다](https://krdict.korean.go.kr/eng/dicSearch/SearchView?ParaWordNo=72225)

## 재생과 회귀 검증

웹과 오프라인 데모에서 각각 50개 전체를 텍스트 읽기로 재생했다. 첫 입모양 4개와 이전 최소대립 예시 2개를 각 데모에서 추가 재생했다. 112회 모두 재생 완료, 기대 음소열, 무음이 아닌 유한한 48 kHz 오디오 버퍼를 확인했다. 기존 영어·터키어·IPA 말하기와 네 가지 노래 예제의 WAV 7개도 upstream과 바이트 단위로 일치했다.

## 항목별 결과

‘수정 후’ 열은 고정한 기대열과 최종 타임라인 양쪽에서 확인한 값이다. 항목별 판정과 전후 WAV의 SHA-256도 보관했다. [전체 측정 JSON](standard-50-results.json)

| 번호 | 유형 | 입력 | 표준 발음(장단 생략) | 관련 조항 | 수정 전 | 수정 후 |
|---:|---|---|---|---|---|---|
| 1 | 연음 | 옷이 | 오시 | 13 | `o ɕ i` | `o ɕ i` |
| 2 | 연음 | 꽃을 | 꼬츨 | 13 | `k͈ o tɕʰ ɯ l` | `k͈ o tɕʰ ɯ l` |
| 3 | 연음 | 밭에 | 바테 | 13 | `p a tʰ e` | `p a tʰ e` |
| 4 | 연음 | 깎아. | 까까 | 13 | `k͈ a k͈ a` | `k͈ a k͈ a` |
| 5 | 연음 | 눈이 와. | 누니 와 | 13 | `n u n i w a` | `n u n i w a` |
| 6 | 연음 | 같이 먹어? | 가치 머거 | 13,17 | `k a tɕʰ i m ʌ g ʌ` | `k a tɕʰ i m ʌ g ʌ` |
| 7 | 연음 | 밭 아래 | 바다래 | 15 | `p a d a ɾ ɛ` | `p a d a ɾ ɛ` |
| 8 | 연음 | 꽃 위 | 꼬뒤 | 15 | `k͈ o d w i` | `k͈ o d w i` |
| 9 | 연음 | 겉옷 | 거돋 | 15 | `k ʌ tʰ o t` | `k ʌ d o t` |
| 10 | 연음 | 맛없다 | 마덥따 | 15,23 | `m a s ʌ p t͈ a` | `m a d ʌ p t͈ a` |
| 11 | 연음 | 헛웃음 | 허두슴 | 15,13 | `h ʌ s u s ɯ m` | `h ʌ d u s ɯ m` |
| 12 | 연음 | 값어치 | 가버치 | 15 | `k a p s͈ ʌ tɕʰ i` | `k a b ʌ tɕʰ i` |
| 13 | 연음 | 닭 앞에 | 다가페 | 15,13 | `t a g a pʰ e` | `t a g a pʰ e` |
| 14 | 겹받침 | 넋이 | 넉씨 | 14 | `n ʌ k ɕ͈ i` | `n ʌ k ɕ͈ i` |
| 15 | 겹받침 | 앉아. | 안자 | 14 | `a n dʑ a` | `a n dʑ a` |
| 16 | 겹받침 | 젊어. | 절머 | 14 | `tɕ ʌ l m ʌ` | `tɕ ʌ l m ʌ` |
| 17 | 겹받침 | 핥아. | 할타 | 14 | `h a l tʰ a` | `h a l tʰ a` |
| 18 | 겹받침 | 읊어. | 을퍼 | 14 | `ɯ l pʰ ʌ` | `ɯ l pʰ ʌ` |
| 19 | 겹받침 | 여덟 | 여덜 | 10 | `j ʌ d ʌ l` | `j ʌ d ʌ l` |
| 20 | 겹받침 | 맑게 | 말께 | 11 | `m a l k͈ e` | `m a l k͈ e` |
| 21 | 겹받침 | 밟다 | 밥따 | 10,23 | `p a p t͈ a` | `p a p t͈ a` |
| 22 | 겹받침 | 앉히다 | 안치다 | 12 | `a n ɦ i d a` | `a n tɕʰ i d a` |
| 23 | 겹받침 | 넓죽하다 | 넙쭈카다 | 10,12,23 | `n ʌ l dʑ u kʰ a d a` | `n ʌ p tɕ͈ u kʰ a d a` |
| 24 | 겹받침 | 넓적하다 | 넙쩌카다 | 10,12,23 | `n ʌ l dʑ ʌ kʰ a d a` | `n ʌ p tɕ͈ ʌ kʰ a d a` |
| 25 | 겹받침 | 읽고 | 일꼬 | 11 | `i l k͈ o` | `i l k͈ o` |
| 26 | 된소리되기 | 국밥 | 국빱 | 23 | `k u k p͈ a p` | `k u k p͈ a p` |
| 27 | 된소리되기 | 옷고름 | 옫꼬름 | 23 | `o t k͈ o ɾ ɯ m` | `o t k͈ o ɾ ɯ m` |
| 28 | 된소리되기 | 앉고 | 안꼬 | 24 | `a n g o` | `a n k͈ o` |
| 29 | 된소리되기 | 얹다 | 언따 | 24 | `ʌ n d a` | `ʌ n t͈ a` |
| 30 | 된소리되기 | 껴안다 | 껴안따 | 24 | `k͈ j ʌ a n d a` | `k͈ j ʌ a n t͈ a` |
| 31 | 된소리되기 | 삼고 | 삼꼬 | 24 | `s a m g o` | `s a m k͈ o` |
| 32 | 된소리되기 | 더듬지 | 더듬찌 | 24 | `t ʌ d ɯ m dʑ i` | `t ʌ d ɯ m tɕ͈ i` |
| 33 | 된소리되기 | 젊지 | 점찌 | 24 | `tɕ ʌ m dʑ i` | `tɕ ʌ m tɕ͈ i` |
| 34 | 된소리되기 | 넓게 | 널께 | 25 | `n ʌ l g e` | `n ʌ l k͈ e` |
| 35 | 된소리되기 | 핥다 | 할따 | 25 | `h a l d a` | `h a l t͈ a` |
| 36 | 된소리되기 | 안기다 | 안기다 | 24 | `a n g i d a` | `a n g i d a` |
| 37 | 된소리되기 | 갈 데가 | 갈떼가 | 27 | `k a l d e g a` | `k a l t͈ e g a` |
| 38 | 된소리되기 | 할 수 있다. | 할 쑤 읻따 | 27,23 | `h a l s u i t t͈ a` | `h a l s͈ u i t t͈ a` |
| 39 | 비음화 | 국물 | 궁물 | 18 | `k u ŋ m u l` | `k u ŋ m u l` |
| 40 | 비음화 | 부엌문 | 부엉문 | 18 | `p u ʌ ŋ m u n` | `p u ʌ ŋ m u n` |
| 41 | 비음화 | 닫는 | 단는 | 18 | `t a n n ɯ n` | `t a n n ɯ n` |
| 42 | 비음화 | 흙만 | 흥만 | 18 | `h ɯ ŋ m a n` | `h ɯ ŋ m a n` |
| 43 | 비음화 | 밥 먹는다. | 밤멍는다 | 18 | `p a m m ʌ ŋ n ɯ n d a` | `p a m m ʌ ŋ n ɯ n d a` |
| 44 | 비음화 | 값 매기다 | 감매기다 | 18 | `k a m m ɛ g i d a` | `k a m m ɛ g i d a` |
| 45 | 비음화 | 의견란 | 의견난 | 20 | `ɰ i g j ʌ l l a n` | `ɰ i g j ʌ n n a n` |
| 46 | 비음화 | 막론 | 망논 | 19 | `m a ŋ n o n` | `m a ŋ n o n` |
| 47 | 비음화 | 협력 | 혐녁 | 19 | `h j ʌ m n j ʌ k` | `h j ʌ m n j ʌ k` |
| 48 | 비음화 | 생산량 | 생산냥 | 20 | `s ɛ ŋ s a l l j a ŋ` | `s ɛ ŋ s a n n j a ŋ` |
| 49 | 비음화 | 꽃잎 | 꼰닙 | 18,29 | `k͈ o tɕʰ i p` | `k͈ o n n i p` |
| 50 | 비음화 | 색연필 | 생년필 | 18,29 | `s ɛ g j ʌ n pʰ i l` | `s ɛ ŋ n j ʌ n pʰ i l` |

## 다시 측정하기

포크의 작업 브랜치 최상위에서 실행한다. 두 실행 파일은 같은 표본과 채점기를 사용한다.

```sh
git worktree add --detach ../chimera-standard50-base a1214b1
cargo build --release -p chimera-cli --manifest-path ../chimera-standard50-base/Cargo.toml
cargo build --release -p chimera-cli
python3 tools/korean/standard50.py --cli ../chimera-standard50-base/target/release/chimera --out before.json
python3 tools/korean/standard50.py --cli target/release/chimera --out after.json
cargo test -p chimera --test korean_speech
```
