//! Korean studio controls on the physical score, scoped to a single breath group.
use crate::anatomy::human::{ArticKey, BodyName};
use crate::control::score::{ControlKey, Gesture, Targets};
use crate::phonetics::planner::{PhraseInput, PlanOptions, plan_utterance};
use crate::phonetics::{Intonation, Plan};

pub fn plan(phrases: &[PhraseInput], options: &PlanOptions, speaker: BodyName) -> Plan {
    let mut all = Plan {
        end: options.t0,
        ..Plan::default()
    };
    let mut t = options.t0;
    for phrase in phrases {
        let tone = phrase.intonation.unwrap_or(Intonation::Statement);
        let mut p = plan_utterance(
            &phrase.segments,
            &PlanOptions {
                t0: t,
                intonation: Some(tone),
                ..options.clone()
            },
        );
        labials(&mut p);
        vowel_resonance(&mut p, speaker);
        if tone == Intonation::Question {
            question_ending(&mut p, speaker);
        }
        all.gestures.append(&mut p.gestures);
        all.segments.append(&mut p.segments);
        all.end = p.end;
        t = p.end + phrase.pause.unwrap_or(0.25);
    }
    all
}

fn labelled(g: &Gesture, name: &str) -> bool {
    g.label.as_ref().is_some_and(|l| l.as_str() == name)
}

fn labials(p: &mut Plan) {
    for (i, stop) in p.segments.iter().enumerate() {
        if !matches!(stop.ipa.as_str(), "p" | "b")
            || !p.segments.get(i + 1).is_some_and(|s| s.kind == "vowel")
        {
            continue;
        }
        let local =
            |g: &Gesture| g.t0 <= stop.t1 + 0.001 && g.t1 >= stop.t0 && g.t0 >= stop.t0 - 0.10;
        let Some(lip) = p.gestures.iter_mut().find(|g| {
            local(g)
                && labelled(g, &stop.ipa)
                && g.targets.get(ArticKey::LipAp).is_some_and(|a| a < 0.0)
                && g.targets.iter().count() == 1
        }) else {
            continue;
        };
        if i == 0 {
            // Close before the first pressure rise. Leave the opening gesture on its original clock.
            lip.t0 = (stop.t0 - 0.125).max(0.0);
            lip.ramp_in = 0.010;
        }
        if stop.ipa == "b"
            && i > 0
            && p.segments[i - 1].kind == "vowel"
            && stop.t0 - p.segments[i - 1].t1 < 0.025
        {
            p.gestures.push(
                Gesture::new(
                    stop.t1 - 0.012,
                    stop.t1 + 0.024,
                    0.016,
                    0.038,
                    2.0,
                    Targets::default().with(ControlKey::PITCH_ST, -2.0),
                )
                .label("lenis transition"),
            );
        }
        for g in p.gestures.iter_mut().filter(|g| local(g)) {
            if stop.display_ipa.as_deref() == Some("p͈") && labelled(g, "pressed release") {
                g.targets.set(ControlKey::PRESS, 0.55);
            } else if stop.display_ipa.as_deref() == Some("pʰ") && labelled(g, "release pitch") {
                if let Some(st) = g.targets.get(ControlKey::PITCH_ST) {
                    g.targets.set(ControlKey::PITCH_ST, st + 1.5);
                }
            }
        }
    }
}

fn vowel_resonance(p: &mut Plan, speaker: BodyName) {
    use ArticKey::*;
    // Inverse distances on the existing calibrated vowel chart at the recorded /ʌ/ F1/F2.
    // These are three preset-specific target poses, not measurements of a person's anatomy.
    let target = match speaker {
        BodyName::Male => [
            1.5706356597639952,
            6.628424763222998,
            0.6639067227700076,
            0.4092068196829222,
            0.618870765381264,
            0.04352980798903512,
            0.23391637153181927,
            0.07231614913207011,
            0.007833768913391059,
        ],
        BodyName::Female => [
            1.4717402556960983,
            6.142225829909578,
            1.29907318894572,
            0.9859883709607049,
            0.23638922195106968,
            0.6543610667897408,
            -0.4346498806345835,
            0.19181942252123463,
            0.00028248305812174997,
        ],
        BodyName::Child => [
            1.9291109719635076,
            7.303391346688684,
            0.6486771571541294,
            0.17151055319361697,
            1.1126020054100196,
            0.26896352164095105,
            -0.5824988020826896,
            -0.2780449946733767,
            0.048504730377421194,
        ],
    };
    for g in p.gestures.iter_mut().filter(|g| labelled(g, "ʌ")) {
        for (key, goal) in [
            TbX, TbY, Jaw, LipAp, LipProt, LipWidth, Root, Larynx, TtCurl,
        ]
        .into_iter()
        .zip(target)
        {
            if let Some(value) = g.targets.get(key) {
                g.targets.set(key, value + 0.40 * (goal - value));
            }
        }
    }
}

fn question_ending(p: &mut Plan, speaker: BodyName) {
    let mut vowels = p.segments.iter().rev().filter(|s| s.kind == "vowel");
    let (Some(last_vowel), Some(previous), Some(_)) = (vowels.next(), vowels.next(), vowels.next())
    else {
        return;
    };
    let tails = [previous, last_vowel].map(|v| (v.t0 + 0.085_f64.min((v.t1 - v.t0) * 0.55), v.t1));
    let map = |t: f64| {
        t - 0.48
            * tails
                .iter()
                .map(|&(start, end)| (t.min(end) - start).max(0.0))
                .sum::<f64>()
    };
    if let Some(final_pitch) = p.gestures.iter_mut().rev().find(|g| {
        labelled(g, "pitch") && g.targets.has(ControlKey::F0) && g.t0 >= last_vowel.t0 - 0.06
    }) {
        let scale = match speaker {
            BodyName::Male => 0.98,
            BodyName::Female => 0.84,
            BodyName::Child => 0.90,
        };
        let f0 = final_pitch.targets.get(ControlKey::F0).unwrap();
        final_pitch.targets.set(ControlKey::F0, f0 * scale);
    }
    if speaker != BodyName::Male {
        let d = last_vowel.t1 - last_vowel.t0;
        let st = if speaker == BodyName::Female {
            -2.5
        } else {
            1.0
        };
        p.gestures.push(
            Gesture::new(
                last_vowel.t0 + 0.78 * d,
                last_vowel.t1,
                0.30 * d,
                0.025,
                1.0,
                Targets::default().with(ControlKey::PITCH_ST, st),
            )
            .label("question tail"),
        );
    }
    for g in &mut p.gestures {
        let a = map(g.t0);
        let b = map(g.t1);
        g.ramp_in = a - map(g.t0 - g.ramp_in);
        g.ramp_out = map(g.t1 + g.ramp_out) - b;
        g.release_hold = g.release_hold.map(|v| map(g.t1 + v) - b);
        g.t0 = a;
        g.t1 = b;
    }
    for s in &mut p.segments {
        s.t0 = map(s.t0);
        s.t1 = map(s.t1);
    }
    p.end = map(p.end);
}
