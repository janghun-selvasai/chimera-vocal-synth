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
