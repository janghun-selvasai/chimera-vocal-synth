//! Lexical boundaries that Hangul spelling alone cannot disambiguate.
//! Entries identify morphemes; join() still computes voicing, liaison and nasal place.
use super::{Block, neutral, simplify, tense};

fn starts_with(blocks: &[Block], spelling: &str) -> bool {
    let mut actual = blocks.iter();
    spelling.chars().all(|c| actual.next().is_some_and(|b| b.text == c))
}

fn ends_with(blocks: &[Block], spelling: &str) -> bool {
    let mut actual = blocks.iter().rev();
    spelling.chars().rev().all(|c| actual.next().is_some_and(|b| b.text == c))
}

// NIKL Standard Pronunciation 15, 20 and 29. Knowing both constituents
// prevents false positives such as 꽃이, 확인, 분량 and 대혼란.
const COMPOUNDS: &[(&str, &str)] = &[
    ("겉", "옷"), ("덧", "옷"), ("헛", "웃"), ("맛", "없"), ("멋", "없"),
    ("값", "어치"), ("꽃", "잎"), ("깻", "잎"), ("나뭇", "잎"), ("색", "연필"),
    ("솜", "이불"), ("막", "일"), ("맨", "입"), ("한", "여름"),
    ("의견", "란"), ("생산", "량"), ("결단", "력"), ("공권", "력"),
    ("횡단", "로"), ("이원", "론"), ("입원", "료"),
];

fn tensing_predicate(left: &[Block]) -> bool {
    let last = left.last().unwrap().text;
    matches!(last, '앉' | '얹' | '젊' | '굶' | '닮' | '삶' | '옮' | '곪'
        | '넓' | '밟' | '얇' | '짧' | '떫' | '핥' | '훑')
        || left.len() == 1 && matches!(last, '삼' | '넘')
        || ["껴안", "끌어안", "떠안", "더듬", "다듬"].iter().any(|s| ends_with(left, s))
}

pub(super) fn within_word(word: &mut [Block]) {
    for i in 1..word.len() {
        let (left, right) = word.split_at_mut(i);
        let last = left.last().unwrap();
        if last.coda.is_empty() {
            continue;
        }
        let next = &right[0];
        if next.onset.is_none() || next.onset == Some('ㄹ') {
            if COMPOUNDS.iter().any(|(a, b)| ends_with(left, a) && starts_with(right, b)) {
                let last = left.last_mut().unwrap();
                if next.onset == Some('ㄹ') || next.glide == "j" || next.vowel == "i" && next.glide.is_empty() {
                    right[0].onset = Some('ㄴ');
                } else {
                    last.coda = simplify(&last.coda).map(neutral).into_iter().collect();
                }
            }
            continue;
        }
        // Rule 10's exceptional 넓- derivatives keep ㅂ. Tensing follows from that coda.
        if last.text == '넓' && (matches!(next.text, '죽' | '적') || starts_with(right, "둥글")) {
            left.last_mut().unwrap().coda = vec!['ㅂ'];
            continue;
        }
        // Rules 24–25 apply to grammatical endings on predicate stems. In
        // particular the causative/passive suffix -기- in 안기다 or 굶기다 stays lax.
        let ending = matches!(next.text, '고' | '곤' | '거' | '게' | '겠' | '다' | '더' | '던' | '든'
            | '듯' | '지' | '죠' | '자' | '소' | '세' | '습');
        if ending && tensing_predicate(left) {
            right[0].onset = next.onset.map(tense);
        }
    }
}

/// Rule 27 for recognized adnominal forms and bound nouns. A space between
/// words is significant: a nominal modifier (서울 시내) and a new phrase keep their own onsets.
pub(super) fn adnominal_tensing(left: &str, right: &str) -> bool {
    const ADNOMINALS: &[&str] = &["갈", "할", "올", "볼", "될", "줄", "쓸", "먹을", "읽을", "입을", "앉을", "만날", "만들"];
    const NOUNS: &[&str] = &["수", "데", "것", "곳", "줄", "바"];
    const PARTICLES: &[&str] = &["", "가", "이", "은", "는", "을", "를", "도", "만", "에", "에서", "으로", "로", "까지", "부터"];
    ADNOMINALS.contains(&left) && NOUNS.iter().any(|noun| right.strip_prefix(noun).is_some_and(|tail| PARTICLES.contains(&tail)))
}
