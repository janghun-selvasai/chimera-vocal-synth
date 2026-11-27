use chimera::phonetics::korean::speech::{Condition, phrases, phrases_with};
use chimera::phonetics::{
    Intonation,
    planner::{PlanOptions, plan_utterance},
};

#[test]
fn sound_rules_survive_speech_planning() {
    for (text, ipa) in [
        ("먹어", "mʌgʌ"),
        ("같이", "katɕi"),
        ("국물", "kuŋmul"),
        ("옷 안", "odan"),
    ] {
        let p = &phrases(text)[0];
        let plan = plan_utterance(&p.segments, &PlanOptions::default());
        assert_eq!(
            plan.segments
                .iter()
                .map(|s| s.ipa.as_str())
                .collect::<String>(),
            ipa
        );
    }
    let p = phrases("옷, 안?");
    assert_eq!(p.len(), 2);
    assert_eq!(p[0].segments.last().unwrap().ipa, "t");
    assert_eq!(p[1].intonation, Intonation::Question);
    assert_eq!(phrases("먹어"), phrases("먹어"));
}

#[test]
fn sibilants_keep_the_post_sandhi_contrast_in_the_clear_condition() {
    for (plain, tense) in [("살", "쌀"), ("시", "씨")] {
        let initial = |text, condition| phrases_with(text, condition)[0].segments[0].clone();
        let a = initial(plain, Condition::Clear);
        let b = initial(tense, Condition::Clear);
        assert_eq!(a.ipa, b.ipa);
        assert_eq!(a.display_ipa, None);
        assert_eq!(b.display_ipa, Some(format!("{}͈", b.ipa)));
        assert!(a.dur.unwrap() < b.dur.unwrap());
        assert!(a.vot.unwrap() > b.vot.unwrap());
        assert!(!a.pressed_release && b.pressed_release);
        assert_eq!(
            initial(plain, Condition::Full),
            initial(tense, Condition::Full)
        );
    }
    // 된소리되기 gives the ㅅ of 국수 a fortis onset within the phrase.
    let medial = phrases("국수")[0]
        .segments
        .iter()
        .find(|s| s.ipa == "s")
        .unwrap()
        .clone();
    assert!(medial.pressed_release);
    assert_eq!(medial.display_ipa.as_deref(), Some("s͈"));
    assert!(medial.vot.is_none());
}

#[test]
fn fortis_adduction_replaces_only_the_stop_opening_and_survives_sandhi() {
    use chimera::control::score::ControlKey;
    for text in ["뿔", "저기 뿔 보여?", "까", "딸", "국밥"] {
        let plans = [Condition::Clear, Condition::Adducted].map(|c| {
            plan_utterance(&phrases_with(text, c)[0].segments, &PlanOptions::default())
        });
        let [before, after] = &plans;
        assert_eq!(before.segments, after.segments);
        let changed: Vec<_> = before.gestures.iter().zip(&after.gestures)
            .filter(|(a, b)| serde_json::to_value(a).unwrap() != serde_json::to_value(b).unwrap()).collect();
        assert_eq!(before.gestures.len(), after.gestures.len());
        assert_eq!(changed.len(), 1, "{text}");
        let (open, close) = changed[0];
        assert!(open.targets.has(ControlKey::ABDUCTION));
        assert_eq!(close.targets.get(ControlKey::CLOSURE), Some(1.0));
        let index = after.segments.iter().position(|s| s.kind == "stop" && (close.t1 - s.t1).abs() < 1e-9).unwrap();
        if index == 0 {
            assert!(close.t0 <= PlanOptions::default().t0);
        } else {
            assert!(close.t0 >= after.segments[index].t0);
        }
    }
    for text in ["불", "저기 불 보여?", "풀", "같이 먹어?", "쌀", "짜", "밥"] {
        assert_eq!(phrases_with(text, Condition::Clear), phrases_with(text, Condition::Adducted));
    }
}

#[test]
fn korean_transcription_covers_modern_syllables_and_intervocalic_onsets() {
    // Unicode order. The entries are the expected displayed phones, independent
    // of the inventory keys used by the synthesizer.
    let initial = ["k", "k͈", "n", "t", "t͈", "ɾ", "m", "p", "p͈", "s", "s͈", "", "tɕ", "tɕ͈", "tɕʰ", "kʰ", "tʰ", "pʰ", "h"];
    let medial = ["g", "k͈", "n", "d", "t͈", "ɾ", "m", "b", "p͈", "s", "s͈", "", "dʑ", "tɕ͈", "tɕʰ", "kʰ", "tʰ", "pʰ", "ɦ"];
    let vowels = ["a", "ɛ", "ja", "jɛ", "ʌ", "e", "jʌ", "je", "o", "wa", "wɛ", "we", "jo", "u", "wʌ", "we", "wi", "ju", "ɯ", "ɰi", "i"];
    let codas = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ŋ", "t", "t", "k", "t", "p", "t"];
    for (i, onset) in initial.iter().enumerate() {
        for (j, &vowel) in vowels.iter().enumerate() {
            for (k, &coda) in codas.iter().enumerate() {
                let syllable = char::from_u32(0xac00 + (i * 588 + j * 28 + k) as u32).unwrap();
                for (prefix, consonant) in [("", *onset), ("아", medial[i])] {
                    let word = format!("{prefix}{syllable}");
                    let phrase = &phrases(&word)[0];
                    let actual: String = phrase.segments.iter().map(|s| s.display_ipa.as_deref().unwrap_or(&s.ipa)).collect();
                    let nucleus = if j == 19 && i != 11 { "i" } else { vowel };
                    let palatal = nucleus.starts_with('j') || nucleus == "i";
                    let onset = match (consonant, palatal) {
                        ("s", true) => "ɕ", ("s͈", true) => "ɕ͈", (other, _) => other
                    };
                    let lead = if prefix.is_empty() { "" } else { "a" };
                    assert_eq!(actual, format!("{lead}{onset}{nucleus}{coda}"), "{word}");
                }
            }
        }
    }
}

#[test]
fn korean_surface_labels_follow_sound_changes_and_explicit_breaks() {
    for (text, expected) in [
        ("불, 풀, 뿔", "pul|pʰul|p͈ul"), ("저기 불", "tɕʌgibul"),
        ("달, 탈, 딸", "tal|tʰal|t͈al"), ("굴, 쿨, 꿀", "kul|kʰul|k͈ul"),
        ("자, 차, 짜", "tɕa|tɕʰa|tɕ͈a"),
        ("같이 먹어?", "katɕʰimʌgʌ"), ("국물", "kuŋmul"), ("국밥", "kukp͈ap"),
        ("좋다", "tɕotʰa"), ("국수", "kuks͈u"), ("값이", "kapɕ͈i"),
        ("넋이", "nʌkɕ͈i"), ("곬이", "kolɕ͈i"), ("옷 안", "odan"), ("옷, 안", "ot|an"),
        ("굳히다", "kutɕʰida"), ("닫히다", "tatɕʰida"),
        ("곧 히죽", "kotʰidʑuk"), ("곧, 히죽", "kot|hidʑuk"),
    ] {
        let actual = phrases(text).iter().map(|p| {
            let plan = plan_utterance(&p.segments, &PlanOptions::default());
            assert!(plan.segments.iter().all(|s| s.kind != "?"), "{text}");
            plan.segments.iter().map(|s| s.display_ipa.as_deref().unwrap_or(&s.ipa)).collect::<String>()
        }).collect::<Vec<_>>().join("|");
        assert_eq!(actual, expected, "{text}");
    }
}

#[test]
fn predicate_lg_depends_on_the_stem_and_the_following_sound() {
    use chimera::phonetics::korean::word_syllables;

    let sung = |word: &str| {
        word_syllables(word).into_iter()
            .map(|s| (s.onset, s.nucleus, s.coda)).collect::<Vec<_>>()
    };
    let spoken = |text: &str| {
        phrases(text).into_iter().map(|p| p.segments).collect::<Vec<_>>()
    };
    for (written, pronounced) in [
        ("읽고", "일꼬"), ("읽거나", "일꺼나"), ("읽겠습니다", "일껟씀니다"),
        ("맑게", "말께"), ("묽고", "물꼬"), ("밝기", "발끼"), ("긁개", "글깨"),
        ("갉고", "갈꼬"), ("굵고", "굴꼬"), ("낡고", "날꼬"), ("늙고", "늘꼬"),
        ("붉고", "불꼬"), ("얽고", "얼꼬"), ("옭고", "올꼬"),
        ("읽히다", "일키다"), ("읽혀", "일켜"), ("밝혔다", "발켣따"), ("긁힌", "글킨"),
        ("뒤얽히다", "뒤얼키다"), ("닭과", "닥꽈"), ("닭고기", "닥꼬기"),
        ("흙길", "흑낄"), ("칡과", "칙꽈"), ("삵과", "삭꽈"), ("닭하고", "다카고"),
        ("읽다", "익따"), ("읽어", "일거"), ("읽는", "잉는"), ("읽지", "익찌"),
    ] {
        assert_eq!(sung(written), sung(pronounced), "Sing: {written}");
        assert_eq!(spoken(written), spoken(pronounced), "Speak: {written}");
    }
    for (text, reference) in [
        ("책을 읽고", "책을 일꼬"), ("읽고, 닭과", "일꼬, 닥꽈"),
        ("읽 고", "익 꼬"), ("읽, 고", "익, 고"), ("읽 히", "이 키"),
    ] {
        assert_eq!(spoken(text), spoken(reference), "word boundary: {text}");
    }
}

#[test]
fn standard_fifty_matches_independent_surface_phones() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!("korean-standard-50.json")).unwrap();
    let mut total = 0;
    for group in corpus["groups"].as_object().unwrap().values() {
        for case in group.as_array().unwrap() {
            let input = case[0].as_str().unwrap();
            let phones: Vec<String> = phrases(input).into_iter().flat_map(|phrase| {
                plan_utterance(&phrase.segments, &PlanOptions::default()).segments.into_iter()
                    .map(|s| s.display_ipa.unwrap_or(s.ipa))
            }).collect();
            assert_eq!(phones.join(" "), case[2].as_str().unwrap(), "{input}");
            total += 1;
        }
    }
    assert_eq!(total, 50);
}

#[test]
fn morpheme_rules_extend_to_new_forms_and_respect_counterexamples() {
    let phones = |text: &str| {
        phrases(text).into_iter().map(|p| p.segments.into_iter()
            .map(|s| s.display_ipa.unwrap_or(s.ipa)).collect::<Vec<_>>()).collect::<Vec<_>>()
    };
    for (text, reference) in [
        ("겉옷을", "거도슬"), ("덧옷", "더돋"), ("막일", "망닐"), ("한여름", "한녀름"),
        ("꽃잎이", "꼰니피"), ("입원료", "이붠뇨"), ("분량", "불량"), ("대혼란", "대홀란"),
        ("얹히다", "언치다"), ("넓혀", "널펴"), ("넓둥글다", "넙뚱글다"),
        ("다듬고", "다듬꼬"), ("앉거든", "안꺼든"), ("앉습니다", "안씀니다"), ("훑소", "훌쏘"),
        ("굶기다", "굼기다"),
        ("먹을 것을", "머글 꺼슬"), ("올 데가", "올 떼가"),
        ("확인", "화긴"), ("꽃이", "꼬치"),
    ] {
        assert_eq!(phones(text), phones(reference), "{text}");
    }
    // Literal controls detect an overapplied rule even when both spellings are identical.
    for (text, expected) in [
        ("남기다", "n a m g i d a"), ("삼국", "s a m g u k"), ("서울 시내", "s ʌ u l ɕ i n ɛ"),
        ("갈, 데가", "k a l | t e g a"), ("할, 수 있다", "h a l | s u i t t͈ a"),
    ] {
        assert_eq!(phones(text).iter().map(|p| p.join(" ")).collect::<Vec<_>>().join(" | "), expected, "{text}");
    }
}

#[test]
fn matched_ablation_changes_only_selected_gestures() {
    for text in ["불", "풀", "뿔", "달", "탈", "딸"] {
        let plans: Vec<_> = [Condition::Vot, Condition::Pitch, Condition::Full]
            .iter()
            .map(|&c| plan_utterance(&phrases_with(text, c)[0].segments, &PlanOptions::default()))
            .collect();
        assert!(plans.windows(2).all(|p| p[0].segments == p[1].segments));
        let other = |p: &chimera::phonetics::Plan| {
            p.gestures
                .iter()
                .copied()
                .filter(|g| {
                    !matches!(
                        g.label.as_ref().map(|x| x.as_str()),
                        Some("release pitch" | "pressed release")
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            serde_json::to_value(other(&plans[0])).unwrap(),
            serde_json::to_value(other(&plans[2])).unwrap()
        );
    }
    let medial = |c| {
        phrases_with("이 불", c)[0]
            .segments
            .iter()
            .find(|s| s.ipa == "b")
            .unwrap()
            .onset_st
    };
    assert_eq!(medial(Condition::Full), None);
    assert_eq!(medial(Condition::Medial), Some(-3.5));
}
