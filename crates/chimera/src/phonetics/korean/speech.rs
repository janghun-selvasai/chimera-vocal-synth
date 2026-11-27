//! Hangul text for Speak. Keep the lyric front end's segment records, including explicit VOT.
use super::{compose, is_hangul, word_syllables};
use crate::phonetics::{Intonation, Segment, english::Phrase};

pub fn is_korean_text(text: &str) -> bool {
    let text = compose(text);
    text.chars().any(is_hangul) && text.chars().all(|c| !c.is_alphanumeric() || is_hangul(c))
}

pub fn phrases(text: &str) -> Vec<Phrase> {
    let text = compose(text);
    let mut result = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    for c in text.chars().chain(['.']) {
        if is_hangul(c) {
            word.push(c);
            continue;
        }
        if !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        if (c == ' ' || c == '\t') || words.is_empty() {
            continue;
        }
        let mut segments: Vec<Segment> = Vec::new();
        for w in &words {
            for syl in word_syllables(w) {
                segments.extend(syl.onset);
                segments.push(syl.nucleus);
                segments.extend(syl.coda);
            }
            segments.last_mut().unwrap().word_end = Some(true);
        }
        result.push(Phrase { segments, intonation: Intonation::Flat, pause: 0.25, words: std::mem::take(&mut words) });
    }
    result
}
