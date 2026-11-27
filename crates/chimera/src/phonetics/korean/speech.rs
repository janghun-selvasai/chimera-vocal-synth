//! Hangul text for Speak. Each condition adds one operation to the same front end.
use super::{
    compose, decompose, is_hangul, neutral, simplify, syllables_from_blocks, word_syllables,
};
use crate::phonetics::{Intonation, Segment, Syllable, english::Phrase};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Condition {
    Baseline,
    Contour,
    Rhythm,
    Vot,
    Pitch,
    Full,
    Medial,
}

pub fn is_korean_text(text: &str) -> bool {
    let text = compose(text);
    text.chars().any(is_hangul) && text.chars().all(|c| !c.is_alphanumeric() || is_hangul(c))
}

fn connected(words: &[String]) -> Vec<Syllable> {
    let mut blocks = Vec::new();
    let mut ends = Vec::new();
    for w in words {
        blocks.extend(w.chars().map(decompose));
        ends.push(blocks.len() - 1);
    }
    // At a lexical word boundary a coda before an independent vowel-initial word
    // moves in its neutralized form (옷 안 → [오단]). Inside a word 같이 still gives [가치].
    for &end in &ends {
        if blocks.get(end + 1).is_some_and(|next| next.onset.is_none()) {
            blocks[end].coda = simplify(&blocks[end].coda)
                .map(neutral)
                .into_iter()
                .collect();
        }
    }
    let mut syllables = syllables_from_blocks(blocks);
    for end in ends {
        syllables[end].word_end = true;
    }
    syllables
}

fn plan_group(words: Vec<String>, boundary: char, condition: Condition) -> Phrase {
    use Condition::*;
    let joined = matches!(condition, Vot | Pitch | Full | Medial);
    let syllables = if joined {
        connected(&words)
    } else {
        words.iter().flat_map(|w| word_syllables(w)).collect()
    };
    let count = syllables.len();
    let mut segments: Vec<Segment> = Vec::new();
    for (i, mut syl) in syllables.into_iter().enumerate() {
        if !matches!(condition, Baseline | Contour) {
            // Allow periodic vowel cycles to emerge even after a 90 ms aspiration.
            syl.nucleus.dur = Some(if i + 1 == count { 0.205 } else { 0.145 });
        }
        if let Some(stop) = syl.onset.first_mut() {
            let fortis = stop.aspirated == Some(false);
            let lax = stop.vot == Some(super::LAX_VOT)
                || matches!(stop.ipa.as_str(), "b" | "d" | "g" | "dʑ");
            if matches!(condition, Pitch | Full | Medial) && (i == 0 || condition == Medial) {
                stop.onset_st = if lax {
                    Some(-3.5)
                } else if fortis || stop.vot.is_some() {
                    Some(1.5)
                } else {
                    None
                };
            }
            stop.pressed_release = fortis && matches!(condition, Full | Medial);
        }
        segments.extend(syl.onset);
        segments.push(syl.nucleus);
        segments.extend(syl.coda);
        if syl.word_end {
            segments.last_mut().unwrap().word_end = Some(true);
        }
    }
    let intonation = if condition == Baseline {
        Intonation::Flat
    } else if matches!(boundary, '?' | '？') {
        Intonation::Question
    } else {
        Intonation::Statement
    };
    let pause = if !joined {
        0.25
    } else if matches!(boundary, ',' | '，' | '·' | ';') {
        0.16
    } else {
        0.32
    };
    Phrase {
        segments,
        intonation,
        pause,
        words,
    }
}

pub fn phrases(text: &str) -> Vec<Phrase> {
    phrases_with(text, Condition::Full)
}

pub fn phrases_with(text: &str, condition: Condition) -> Vec<Phrase> {
    let mut result = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    for c in compose(text).chars().chain(['.']) {
        if is_hangul(c) {
            word.push(c);
            continue;
        }
        if !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        if !(c.is_whitespace() && !matches!(c, '\n' | '\r')) && !words.is_empty() {
            result.push(plan_group(std::mem::take(&mut words), c, condition));
        }
    }
    result
}
