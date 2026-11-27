//! Hangul text for Speak. Each condition adds one operation to the same front end.
use super::{
    compose, decompose, is_hangul, neutral, pronounced_blocks, simplify, syllables_from_pronounced,
    word_syllables,
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
    Clear,
    Adducted,
    Studio,
}

pub fn studio_source(
    body: crate::anatomy::human::BodyName,
) -> crate::voice::human_voice::VoiceSource {
    use crate::anatomy::human::BodyName;
    use crate::voice::human_voice::{DEFAULT_SOURCE, VoiceSource};
    // Three individual demo voices. Body geometry and its open-phase correction remain calibrated.
    let (f0, brightness) = match body {
        BodyName::Male => (112.0, 0.25),
        BodyName::Female => (205.0, 0.28),
        BodyName::Child => (285.0, 0.34),
    };
    VoiceSource {
        f0,
        brightness,
        ..DEFAULT_SOURCE
    }
}

pub fn is_korean_text(text: &str) -> bool {
    let text = compose(text);
    text.chars().any(is_hangul) && text.chars().all(|c| !c.is_alphanumeric() || is_hangul(c))
}

/// Contrast markers realized by a Korean segment's laryngeal controls. Old
/// traces retain these controls even when their timeline has only inventory IPA.
pub fn marked_ipa(s: &Segment) -> Option<String> {
    let mark = match s.ipa.as_str() {
        "p" | "t" | "k" | "tɕ" if s.aspirated == Some(false) => "͈",
        "p" | "t" | "k" | "tɕ" if s.aspirated == Some(true) && s.vot == Some(super::ASPIRATED_VOT) => "ʰ",
        "s" | "ɕ" if s.pressed_release => "͈",
        _ => return None,
    };
    Some(format!("{}{mark}", s.ipa))
}

fn connected(words: &[String], clear: bool) -> Vec<Syllable> {
    let mut blocks = Vec::new();
    let mut ends = Vec::new();
    for (i, w) in words.iter().enumerate() {
        let start = blocks.len();
        blocks.extend(w.chars().map(decompose));
        super::morphology::within_word(&mut blocks[start..]);
        if i > 0 && super::morphology::adnominal_tensing(&words[i - 1], w) {
            blocks[start].onset = blocks[start].onset.map(super::tense);
        }
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
    let blocks = pronounced_blocks(blocks, &ends);
    let mut syllables = syllables_from_pronounced(&blocks);
    if clear {
        for (i, (block, syllable)) in blocks.iter().zip(&mut syllables).enumerate() {
            if !matches!(block.onset, Some('ㅅ' | 'ㅆ')) {
                continue;
            }
            let fortis = block.onset == Some('ㅆ');
            let s = &mut syllable.onset[0];
            s.pressed_release = fortis;
            if i == 0 {
                // Rounded experimental targets from Chang (2013), Figs 2–3. The high-front
                // context has a smaller contrast than the open vowel. Interpolate other vowels
                // with the pooled values rather than treating /a/ as universal.
                let (frication, aspiration) = match (s.ipa.as_str(), block.vowel, fortis) {
                    ("ɕ", _, false) => (0.165, 0.016),
                    ("ɕ", _, true) => (0.180, 0.006),
                    (_, "a", false) => (0.095, 0.050),
                    (_, "a", true) => (0.150, 0.009),
                    (_, _, false) => (0.130, 0.035),
                    (_, _, true) => (0.165, 0.008),
                };
                s.dur = Some(frication);
                s.vot = Some(aspiration);
            } else if fortis {
                s.length = Some(1.2);
            }
        }
    }
    for end in ends {
        syllables[end].word_end = true;
    }
    syllables
}

fn plan_group(words: Vec<String>, boundary: char, condition: Condition) -> Phrase {
    use Condition::*;
    let clear = matches!(condition, Clear | Adducted | Studio);
    let joined = clear || matches!(condition, Vot | Pitch | Full | Medial);
    let syllables = if joined {
        connected(&words, clear)
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
        if let Some(stop) = syl
            .onset
            .first_mut()
            .filter(|s| !matches!(s.ipa.as_str(), "s" | "ɕ"))
        {
            let fortis = stop.aspirated == Some(false);
            let lax = stop.vot == Some(super::LAX_VOT)
                || matches!(stop.ipa.as_str(), "b" | "d" | "g" | "dʑ");
            if (clear || matches!(condition, Pitch | Full | Medial)) && (i == 0 || condition == Medial)
            {
                stop.onset_st = if lax {
                    Some(-3.5)
                } else if fortis || stop.vot.is_some() {
                    Some(1.5)
                } else {
                    None
                };
            }
            stop.pressed_release = fortis && (clear || matches!(condition, Full | Medial));
            stop.adducted_stop = matches!(condition, Adducted | Studio) && fortis && matches!(stop.ipa.as_str(), "p" | "t" | "k");
        }
        // Mark the realized onset after liaison, voicing and tensification. A
        // lenis stop may also aspirate initially, but has its own shorter VOT.
        if let Some(onset) = syl.onset.first_mut() {
            onset.display_ipa = marked_ipa(onset);
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
    phrases_with(text, Condition::Clear)
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
