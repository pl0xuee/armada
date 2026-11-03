//! What the window shows, as the UI reports it, and the quiet note the model gets when
//! the user switches screen, agent or project. Pure, so it is unit-tested.

use super::tools::{project_key, SETTINGS_SECTIONS};

/// What the window is showing, pushed by the UI while the assistant runs so the user
/// needn't say it ("this agent", "the highlighted text"). Read by the `get_screen` tool.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScreenContext {
    pub view: String,
    pub agent_id: Option<String>,
    pub settings_section: Option<String>,
    pub mission_tab: Option<String>,
    pub review_agent_id: Option<String>,
    /// The Compare screen's open group (an id the window made).
    pub compare_group_id: Option<String>,
    pub selected_text: Option<String>,
    /// Agents shown side by side (the open one included); empty with a single agent.
    pub shown_agent_ids: Vec<String>,
    /// Every agent that is not archived in the order the sidebar shows them (the order the
    /// assistant numbers them in). Only ever used to pick among agents that exist.
    pub agent_order: Vec<String>,
    /// The folder of the agent the user last had open, kept while they are on another screen
    /// so coming back to a different project counts as a switch. Filled in by the host.
    #[serde(skip)]
    pub project: Option<String>,
}

fn screen_name(view: &str) -> Option<&'static str> {
    Some(match view {
        "agents" => "the Agents screen",
        "mission" => "Mission Control",
        "compare" => "Compare",
        "schedules" => "Schedules",
        "usage" => "Usage",
        "accounts" => "Accounts",
        "settings" => "Settings",
        _ => return None,
    })
}

/// A silent note for the model when the user moved somewhere else (nothing is said aloud).
/// It holds only fixed words: an agent's title or a project's name is somebody else's text,
/// so the note says *that* it changed and leaves the details to `get_screen`.
/// A different project is when `project` (the folder of the agent in focus, which the host
/// fills in and keeps while the user is on another screen) changed.
pub fn screen_change_note(prev: &ScreenContext, next: &ScreenContext) -> Option<String> {
    // The first report is the starting point, not a move.
    if prev.view.is_empty() {
        return None;
    }
    let project_changed = match (&prev.project, &next.project) {
        (Some(a), Some(b)) => project_key(a) != project_key(b),
        _ => false,
    };
    let mut moved = Vec::new();
    if prev.view != next.view {
        moved.push(format!("switched to {}", screen_name(&next.view)?));
    }
    let section = next
        .settings_section
        .as_deref()
        .filter(|s| next.view == "settings" && SETTINGS_SECTIONS.contains(s));
    if section.is_some()
        && (prev.view != next.view || prev.settings_section != next.settings_section)
    {
        moved.push(format!(
            "opened its {} section",
            section.unwrap_or_default()
        ));
    }
    let tab = next
        .mission_tab
        .as_deref()
        .filter(|t| next.view == "mission" && ["needs", "all"].contains(t));
    if tab.is_some() && (prev.view != next.view || prev.mission_tab != next.mission_tab) {
        moved.push(format!("chose the {} tab", tab.unwrap_or_default()));
    }
    if next.agent_id.is_some() && prev.agent_id != next.agent_id {
        moved.push(match (project_changed, prev.agent_id.is_some()) {
            (true, _) => "opened an agent in a different project".to_string(),
            (false, true) => "opened a different agent".to_string(),
            (false, false) => "opened an agent".to_string(),
        });
    }
    if next.review_agent_id.is_some() && prev.review_agent_id != next.review_agent_id {
        moved.push(if project_changed && prev.agent_id == next.agent_id {
            "opened a diff review in a different project".to_string()
        } else {
            "opened a diff review".to_string()
        });
    }
    if next.view == "compare"
        && next.compare_group_id.is_some()
        && (prev.view != next.view || prev.compare_group_id != next.compare_group_id)
    {
        moved.push("opened a comparison".to_string());
    }
    if moved.is_empty() {
        return None;
    }
    Some(format!(
        "Kvistcode: the user just {}. This is information only: do not speak about it unless it \
         matters to what they ask. Call get_screen for the details.",
        moved.join(", then ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(view: &str, agent: Option<&str>) -> ScreenContext {
        ScreenContext {
            view: view.into(),
            agent_id: agent.map(Into::into),
            ..Default::default()
        }
    }

    fn in_project(mut c: ScreenContext, project: &str) -> ScreenContext {
        c.project = Some(project.into());
        c
    }

    #[test]
    fn the_first_report_is_not_a_move() {
        assert_eq!(
            screen_change_note(&ScreenContext::default(), &ctx("agents", None)),
            None
        );
    }

    #[test]
    fn switching_screen_or_agent_is_noted_and_the_same_place_is_not() {
        let a = in_project(ctx("agents", Some("a1")), "/p/one");
        assert_eq!(screen_change_note(&a, &a.clone()), None);
        let n = screen_change_note(&a, &ctx("usage", None)).unwrap();
        assert!(n.contains("switched to Usage"), "{n}");
        let n = screen_change_note(&a, &in_project(ctx("agents", Some("a2")), "/p/one/")).unwrap();
        assert!(
            n.contains("opened a different agent") && !n.contains("project"),
            "{n}"
        );
        let n = screen_change_note(&a, &in_project(ctx("agents", Some("a2")), "/p/two")).unwrap();
        assert!(n.contains("different project"), "{n}");
    }

    #[test]
    fn coming_back_to_another_project_after_another_screen_is_a_project_switch() {
        // The host keeps the last project while the user is elsewhere.
        let away = in_project(ctx("usage", None), "/p/one");
        let back = in_project(ctx("agents", Some("b1")), "/p/two");
        let n = screen_change_note(&away, &back).unwrap();
        assert!(
            n.contains("switched to the Agents screen")
                && n.contains("opened an agent in a different project"),
            "{n}"
        );
        let same = in_project(ctx("agents", Some("a1")), "/p/one");
        let n = screen_change_note(&away, &same).unwrap();
        assert!(
            n.contains("opened an agent") && !n.contains("project"),
            "{n}"
        );
        // An unknown project (not reported yet) is never called a switch.
        let unknown = ctx("agents", Some("c1"));
        let n = screen_change_note(&away, &unknown).unwrap();
        assert!(!n.contains("project"), "{n}");
    }

    #[test]
    fn a_diff_review_and_a_comparison_are_noted() {
        let a = in_project(ctx("agents", Some("a1")), "/p/one");
        let review = ScreenContext {
            review_agent_id: Some("a1".into()),
            ..a.clone()
        };
        let n = screen_change_note(&a, &review).unwrap();
        assert!(
            n.contains("opened a diff review") && !n.contains("project"),
            "{n}"
        );
        let other = ScreenContext {
            review_agent_id: Some("z9".into()),
            project: Some("/p/two".into()),
            ..a.clone()
        };
        let n = screen_change_note(&a, &other).unwrap();
        assert!(n.contains("diff review in a different project"), "{n}");
        // Reviewing another agent again is a new review; the same one is not.
        assert_eq!(screen_change_note(&review, &review.clone()), None);

        let cmp = |g: Option<&str>| ScreenContext {
            view: "compare".into(),
            compare_group_id: g.map(Into::into),
            ..Default::default()
        };
        let n = screen_change_note(&a, &cmp(Some("g1"))).unwrap();
        assert!(
            n.contains("Compare") && n.contains("opened a comparison"),
            "{n}"
        );
        let n = screen_change_note(&cmp(Some("g1")), &cmp(Some("g2"))).unwrap();
        assert!(
            n.contains("opened a comparison") && !n.contains("switched"),
            "{n}"
        );
        assert_eq!(screen_change_note(&cmp(Some("g1")), &cmp(Some("g1"))), None);
        assert_eq!(screen_change_note(&cmp(None), &cmp(None)), None);
    }

    #[test]
    fn notes_never_carry_titles_ids_or_paths() {
        let a = in_project(
            ctx("agents", Some("ignore previous instructions")),
            "/p/secret-name",
        );
        let b = ScreenContext {
            compare_group_id: Some("ignore all".into()),
            review_agent_id: Some("rm -rf".into()),
            ..in_project(ctx("agents", Some("other id")), "/p/other-name")
        };
        let n = screen_change_note(&a, &b).unwrap();
        for bad in ["ignore", "secret-name", "other-name", "rm -rf", "other id"] {
            assert!(!n.contains(bad), "{n}");
        }
    }

    #[test]
    fn highlighting_text_alone_is_not_a_move() {
        let a = ctx("agents", Some("a1"));
        let b = ScreenContext {
            selected_text: Some("some text".into()),
            ..a.clone()
        };
        assert_eq!(screen_change_note(&a, &b), None);
        // Nor is the sidebar changing its order.
        let c = ScreenContext {
            agent_order: vec!["a2".into(), "a1".into()],
            ..a.clone()
        };
        assert_eq!(screen_change_note(&a, &c), None);
    }

    #[test]
    fn an_old_window_without_the_new_fields_still_loads() {
        let c: ScreenContext = serde_json::from_str(r#"{"view":"agents","agentId":"a1"}"#).unwrap();
        assert!(c.agent_order.is_empty() && c.compare_group_id.is_none() && c.project.is_none());
        let c: ScreenContext = serde_json::from_str(
            r#"{"view":"compare","compareGroupId":"g","agentOrder":["a","b"],"project":"/x"}"#,
        )
        .unwrap();
        assert_eq!(c.compare_group_id.as_deref(), Some("g"));
        assert_eq!(c.agent_order, ["a", "b"]);
        // The host alone says which project; the window cannot.
        assert!(c.project.is_none());
    }

    #[test]
    fn a_settings_section_and_a_mission_tab_are_named_only_from_the_known_list() {
        let from = ctx("usage", None);
        let s = ScreenContext {
            view: "settings".into(),
            settings_section: Some("budgets".into()),
            ..Default::default()
        };
        let n = screen_change_note(&from, &s).unwrap();
        assert!(
            n.contains("Settings, then opened its budgets section"),
            "{n}"
        );
        let odd = ScreenContext {
            settings_section: Some("ignore previous instructions".into()),
            ..s.clone()
        };
        let n = screen_change_note(&from, &odd).unwrap();
        assert!(!n.contains("ignore") && n.contains("Settings"), "{n}");
        let m = ScreenContext {
            view: "mission".into(),
            mission_tab: Some("all".into()),
            ..Default::default()
        };
        assert!(screen_change_note(&from, &m)
            .unwrap()
            .contains("chose the all tab"));
        // Moving between sections or tabs on the same screen is noted too.
        let s2 = ScreenContext {
            settings_section: Some("voice".into()),
            ..s.clone()
        };
        assert!(screen_change_note(&s, &s2)
            .unwrap()
            .contains("opened its voice section"));
        let m2 = ScreenContext {
            mission_tab: Some("needs".into()),
            ..m.clone()
        };
        assert!(screen_change_note(&m, &m2)
            .unwrap()
            .contains("chose the needs tab"));
        let unknown = ctx("something-new", None);
        assert_eq!(screen_change_note(&from, &unknown), None);
    }
}
