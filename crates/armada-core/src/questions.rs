//! Questions agents ask the user, in the three shapes they arrive in, turned into
//! `QuestionField`s for the timeline, and the user's answers turned back:
//! - ACP form elicitations (`elicitation/create`, a JSON Schema object): how
//!   claude-agent-acp presents Claude Code's AskUserQuestion (`question_<n>` with a
//!   `question_<n>_custom` "Other" box) and MCP servers' forms;
//! - Codex's `item/tool/requestUserInput` questions;
//! - Codex's `mcpServer/elicitation/request` (the same JSON Schema forms).

use serde_json::{json, Map, Value};

use crate::model::{QuestionField, QuestionKind, QuestionOption};

/// Fields of a form elicitation's `requestedSchema` (an object schema).
pub fn fields_from_schema(schema: &Value) -> Vec<QuestionField> {
    let Some(props) = schema["properties"].as_object() else {
        return Vec::new();
    };
    let required: Vec<&str> = schema["required"]
        .as_array()
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut keys: Vec<&String> = props.keys().collect();
    // JSON objects arrive unordered here: keep `question_2` before `question_10`,
    // and each "Other" box right after the field it belongs to.
    keys.sort_by_key(|a| natural_key(a));
    keys.into_iter()
        .map(|key| {
            let prop = &props[key.as_str()];
            let base = key
                .strip_suffix("_custom")
                .filter(|b| props.contains_key(*b));
            let (kind, options) = kind_and_options(prop);
            QuestionField {
                id: key.clone(),
                title: text(&prop["title"]),
                description: text(&prop["description"]),
                kind,
                options,
                other_for: base.map(str::to_string),
                required: required.contains(&key.as_str()),
                secret: prop["format"].as_str() == Some("password"),
            }
        })
        .collect()
}

/// Sort key that compares embedded numbers by value: `question_2` < `question_10`.
fn natural_key(key: &str) -> Vec<(String, u64)> {
    let mut parts = Vec::new();
    let mut text = String::new();
    let mut digits = String::new();
    for c in key.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else {
            if !digits.is_empty() {
                parts.push((
                    std::mem::take(&mut text),
                    digits.parse().unwrap_or(u64::MAX),
                ));
                digits.clear();
            }
            text.push(c);
        }
    }
    parts.push((text, digits.parse().unwrap_or(0)));
    parts
}

fn text(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Choices from `oneOf`/`anyOf` (`{const, title, description}`) or `enum` (with
/// optional `enumNames`).
fn choices(schema: &Value) -> Vec<QuestionOption> {
    let titled = schema["oneOf"]
        .as_array()
        .or_else(|| schema["anyOf"].as_array());
    if let Some(list) = titled {
        return list
            .iter()
            .filter_map(|o| {
                let value = match &o["const"] {
                    Value::String(s) => s.clone(),
                    Value::Null => return None,
                    other => other.to_string(),
                };
                Some(QuestionOption {
                    label: text(&o["title"]).unwrap_or_else(|| value.clone()),
                    description: text(&o["description"]),
                    value,
                })
            })
            .collect();
    }
    let names = schema["enumNames"].as_array();
    schema["enum"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .enumerate()
                .filter_map(|(i, v)| {
                    let value = v
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| v.to_string());
                    let label = names
                        .and_then(|n| n.get(i))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| value.clone());
                    (!value.is_empty()).then_some(QuestionOption {
                        value,
                        label,
                        description: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn kind_and_options(prop: &Value) -> (QuestionKind, Vec<QuestionOption>) {
    match prop["type"].as_str() {
        Some("array") => (QuestionKind::Multi, choices(&prop["items"])),
        Some("boolean") => (QuestionKind::Boolean, Vec::new()),
        Some("number" | "integer") => (QuestionKind::Number, Vec::new()),
        _ => {
            let options = choices(prop);
            if options.is_empty() {
                (QuestionKind::Text, options)
            } else {
                (QuestionKind::Single, options)
            }
        }
    }
}

/// The answers as a form elicitation's `content`: only fields the form asked for,
/// in the type each one wants (numbers stay numbers, `integer` fields whole).
pub fn content_for_schema(schema: &Value, answers: &Map<String, Value>) -> Map<String, Value> {
    let props = schema["properties"].as_object();
    answers
        .iter()
        .filter_map(|(key, value)| {
            let prop = props?.get(key)?;
            let value = match (prop["type"].as_str(), value) {
                (Some("integer"), Value::Number(n)) => n
                    .as_i64()
                    .map(Value::from)
                    .or_else(|| n.as_f64().map(|f| Value::from(f.round() as i64)))?,
                (Some("number" | "integer"), Value::String(s)) => {
                    let n: f64 = s.trim().parse().ok()?;
                    if prop["type"] == "integer" {
                        Value::from(n.round() as i64)
                    } else {
                        json!(n)
                    }
                }
                (Some("string"), Value::String(s)) if s.trim().is_empty() => return None,
                (_, v) => v.clone(),
            };
            Some((key.clone(), value))
        })
        .collect()
}

/// Suffix of the free-text box Armada adds to a Codex question that allows its
/// own answer (`isOther`).
const CODEX_OTHER: &str = "__other";

/// Fields of Codex's `item/tool/requestUserInput` questions.
pub fn fields_from_codex(questions: &[Value]) -> Vec<QuestionField> {
    let mut fields = Vec::new();
    for q in questions {
        let Some(id) = q["id"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let options: Vec<QuestionOption> = q["options"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|o| {
                        let label = text(&o["label"])?;
                        Some(QuestionOption {
                            value: label.clone(),
                            label,
                            description: text(&o["description"]),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let choice = !options.is_empty();
        fields.push(QuestionField {
            id: id.to_string(),
            title: text(&q["header"]),
            description: text(&q["question"]),
            kind: if choice {
                QuestionKind::Single
            } else {
                QuestionKind::Text
            },
            options,
            other_for: None,
            required: false,
            secret: !choice && q["isSecret"].as_bool().unwrap_or(false),
        });
        if choice && q["isOther"].as_bool().unwrap_or(false) {
            fields.push(QuestionField {
                id: format!("{id}{CODEX_OTHER}"),
                title: Some("Other".into()),
                description: Some("Type your own answer instead (optional).".into()),
                kind: QuestionKind::Text,
                options: Vec::new(),
                other_for: Some(id.to_string()),
                required: false,
                secret: false,
            });
        }
    }
    fields
}

/// The answers in Codex's `requestUserInput` response shape: per question id, the
/// chosen label(s), or the typed answer when the user wrote their own.
pub fn codex_answers(fields: &[QuestionField], answers: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    for f in fields.iter().filter(|f| f.other_for.is_none()) {
        let own = answers
            .get(&format!("{}{CODEX_OTHER}", f.id))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let picked: Vec<String> = match answers.get(&f.id) {
            Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            Some(Value::Bool(b)) => vec![b.to_string()],
            Some(Value::Number(n)) => vec![n.to_string()],
            _ => Vec::new(),
        };
        let list = match own {
            Some(text) => vec![text.to_string()],
            None => picked,
        };
        if !list.is_empty() {
            out.insert(f.id.clone(), json!({ "answers": list }));
        }
    }
    json!({ "answers": out })
}

/// The answers in one line, by field label: "Database: Postgres · Features: Auth, Search".
/// Secret fields show as dots; an "Other" box joins its field's answer.
pub fn summary(fields: &[QuestionField], answers: &Map<String, Value>) -> String {
    let show = |f: &QuestionField, v: &Value| -> Option<String> {
        if f.secret {
            return Some("\u{2022}\u{2022}\u{2022}\u{2022}".into());
        }
        let label = |value: &str| {
            f.options
                .iter()
                .find(|o| o.value == value)
                .map_or_else(|| value.to_string(), |o| o.label.clone())
        };
        let text = match v {
            Value::String(s) => label(s.trim()),
            Value::Array(a) => a
                .iter()
                .filter_map(Value::as_str)
                .map(label)
                .collect::<Vec<_>>()
                .join(", "),
            Value::Bool(true) => "Yes".into(),
            Value::Bool(false) => "No".into(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        };
        (!text.is_empty()).then_some(text)
    };
    fields
        .iter()
        .filter(|f| f.other_for.is_none())
        .filter_map(|f| {
            let mut parts: Vec<String> = answers
                .get(&f.id)
                .and_then(|v| show(f, v))
                .into_iter()
                .collect();
            for other in fields
                .iter()
                .filter(|o| o.other_for.as_deref() == Some(f.id.as_str()))
            {
                parts.extend(answers.get(&other.id).and_then(|v| show(other, v)));
            }
            if parts.is_empty() {
                return None;
            }
            let name = f.title.as_deref().or(f.description.as_deref());
            Some(match name {
                Some(n) => format!("{n}: {}", parts.join(", ")),
                None => parts.join(", "),
            })
        })
        .collect::<Vec<_>>()
        .join(" \u{b7} ")
}

/// The answers as they are kept in the conversation: the values of secret fields (a
/// pasted key or password) are replaced, so they are never stored or sent to other
/// screens. The agent still gets the real values.
pub fn redact(fields: &[QuestionField], answers: &Map<String, Value>) -> Map<String, Value> {
    answers
        .iter()
        .map(|(key, value)| {
            let secret = fields.iter().any(|f| &f.id == key && f.secret);
            let shown = if secret && !value.is_null() {
                Value::String("\u{2022}\u{2022}\u{2022}\u{2022}".into())
            } else {
                value.clone()
            };
            (key.clone(), shown)
        })
        .collect()
}

/// Checks submitted answers against the fields: known ids, the right types, and
/// every required field filled. Returns a message for the user when they aren't.
pub fn validate(fields: &[QuestionField], answers: &Map<String, Value>) -> Result<(), String> {
    for (key, value) in answers {
        let Some(f) = fields.iter().find(|f| &f.id == key) else {
            return Err(format!("\u{201c}{key}\u{201d} isn't part of this question"));
        };
        let ok = match f.kind {
            QuestionKind::Single => value
                .as_str()
                .is_some_and(|v| f.options.iter().any(|o| o.value == v)),
            QuestionKind::Multi => value.as_array().is_some_and(|a| {
                a.iter().all(|v| {
                    v.as_str()
                        .is_some_and(|v| f.options.iter().any(|o| o.value == v))
                })
            }),
            QuestionKind::Text => value.is_string(),
            QuestionKind::Boolean => value.is_boolean(),
            QuestionKind::Number => {
                value.is_number()
                    || value
                        .as_str()
                        .is_some_and(|s| s.trim().parse::<f64>().is_ok())
            }
        };
        if !ok {
            return Err(format!(
                "That's not a valid answer for \u{201c}{}\u{201d}",
                f.title
                    .as_deref()
                    .or(f.description.as_deref())
                    .unwrap_or(&f.id)
            ));
        }
    }
    let filled = |id: &str| match answers.get(id) {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(_) => true,
    };
    // A choice field is also answered by its "Other" box.
    let answered = |f: &QuestionField| {
        filled(&f.id)
            || fields
                .iter()
                .any(|o| o.other_for.as_deref() == Some(f.id.as_str()) && filled(&o.id))
    };
    if let Some(f) = fields.iter().find(|f| f.required && !answered(f)) {
        return Err(format!(
            "Answer \u{201c}{}\u{201d} first",
            f.title
                .as_deref()
                .or(f.description.as_deref())
                .unwrap_or(&f.id)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What claude-agent-acp sends for an AskUserQuestion with two questions.
    fn ask_user_question() -> Value {
        json!({
            "type": "object",
            "properties": {
                "question_1_custom": { "type": "string", "title": "Other" },
                "question_0": {
                    "type": "string", "title": "Database", "description": "Which database?",
                    "oneOf": [
                        { "const": "Postgres", "title": "Postgres", "description": "Relational" },
                        { "const": "SQLite", "title": "SQLite" }
                    ]
                },
                "question_1": {
                    "type": "array", "title": "Features", "description": "Which features?",
                    "items": { "anyOf": [ { "const": "Auth", "title": "Auth" }, { "const": "Search", "title": "Search" } ] }
                },
                "question_0_custom": { "type": "string", "title": "Other" }
            }
        })
    }

    #[test]
    fn ask_user_question_becomes_fields() {
        let fields = fields_from_schema(&ask_user_question());
        let ids: Vec<&str> = fields.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "question_0",
                "question_0_custom",
                "question_1",
                "question_1_custom"
            ]
        );
        assert_eq!(fields[0].kind, QuestionKind::Single);
        assert_eq!(fields[0].title.as_deref(), Some("Database"));
        assert_eq!(
            fields[0].options[0].description.as_deref(),
            Some("Relational")
        );
        assert_eq!(fields[1].other_for.as_deref(), Some("question_0"));
        assert_eq!(fields[2].kind, QuestionKind::Multi);
        assert_eq!(fields[2].options.len(), 2);
        assert_eq!(fields[3].other_for.as_deref(), Some("question_1"));
        let answers: Map<String, Value> = serde_json::from_value(json!({
            "question_0": "SQLite", "question_1": ["Auth", "Search"], "question_1_custom": "Billing"
        }))
        .unwrap();
        assert_eq!(
            summary(&fields, &answers),
            "Database: SQLite \u{b7} Features: Auth, Search, Billing"
        );

        let mut many = Map::new();
        for i in [10, 2, 1] {
            many.insert(format!("question_{i}"), json!({ "type": "string" }));
        }
        let order: Vec<String> = fields_from_schema(&json!({ "properties": many }))
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert_eq!(order, ["question_1", "question_2", "question_10"]);
    }

    #[test]
    fn mcp_forms_become_fields_and_answers_keep_their_types() {
        let schema = json!({
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": { "type": "string", "title": "Repository name" },
                "private": { "type": "boolean", "title": "Private" },
                "stars": { "type": "integer" },
                "token": { "type": "string", "format": "password" },
                "color": { "type": "string", "enum": ["r", "g"], "enumNames": ["Red", "Green"] }
            }
        });
        let fields = fields_from_schema(&schema);
        let by = |id: &str| fields.iter().find(|f| f.id == id).unwrap();
        assert!(by("name").required && by("name").kind == QuestionKind::Text);
        assert_eq!(by("private").kind, QuestionKind::Boolean);
        assert_eq!(by("stars").kind, QuestionKind::Number);
        assert!(by("token").secret);
        assert_eq!(by("color").kind, QuestionKind::Single);
        assert_eq!(by("color").options[1].label, "Green");

        let answers: Map<String, Value> = serde_json::from_value(json!({
            "name": "armada", "private": true, "stars": "41.6", "color": "g", "token": "  "
        }))
        .unwrap();
        assert_eq!(validate(&fields, &answers), Ok(()));
        let content = content_for_schema(&schema, &answers);
        assert_eq!(
            Value::Object(content),
            json!({ "name": "armada", "private": true, "stars": 42, "color": "g" })
        );

        let missing: Map<String, Value> =
            serde_json::from_value(json!({ "private": false })).unwrap();
        assert!(validate(&fields, &missing)
            .unwrap_err()
            .contains("Repository name"));
        let bad: Map<String, Value> =
            serde_json::from_value(json!({ "name": "x", "color": "blue" })).unwrap();
        assert!(validate(&fields, &bad).is_err());
        let unknown: Map<String, Value> =
            serde_json::from_value(json!({ "name": "x", "nope": 1 })).unwrap();
        assert!(validate(&fields, &unknown).is_err());
    }

    #[test]
    fn secret_answers_are_not_kept() {
        let schema = json!({ "type": "object", "properties": {
            "name": { "type": "string" }, "token": { "type": "string", "format": "password" } } });
        let fields = fields_from_schema(&schema);
        let answers: Map<String, Value> =
            serde_json::from_value(json!({ "name": "armada", "token": "sk-secret" })).unwrap();
        let kept = redact(&fields, &answers);
        assert_eq!(kept["name"], "armada");
        assert!(!kept["token"].as_str().unwrap().contains("sk-secret"));
        // What the agent gets is untouched.
        assert_eq!(content_for_schema(&schema, &answers)["token"], "sk-secret");
        // The one-line summary doesn't show it either.
        assert!(!summary(&fields, &kept).contains("sk-secret"));
    }

    #[test]
    fn codex_questions_round_trip() {
        let questions = vec![
            json!({ "id": "db", "header": "Database", "question": "Which one?", "isOther": true,
                    "options": [ { "label": "Postgres", "description": "Relational" }, { "label": "SQLite", "description": "" } ] }),
            json!({ "id": "key", "header": "API key", "question": "Paste it", "isSecret": true, "options": null }),
        ];
        let fields = fields_from_codex(&questions);
        let ids: Vec<&str> = fields.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, ["db", "db__other", "key"]);
        assert_eq!(fields[1].other_for.as_deref(), Some("db"));
        assert!(fields[2].secret && fields[2].kind == QuestionKind::Text);

        let picked: Map<String, Value> =
            serde_json::from_value(json!({ "db": "SQLite", "key": "abc" })).unwrap();
        assert_eq!(
            codex_answers(&fields, &picked),
            json!({ "answers": { "db": { "answers": ["SQLite"] }, "key": { "answers": ["abc"] } } })
        );
        let own: Map<String, Value> =
            serde_json::from_value(json!({ "db": "SQLite", "db__other": "MySQL" })).unwrap();
        assert_eq!(
            codex_answers(&fields, &own),
            json!({ "answers": { "db": { "answers": ["MySQL"] } } })
        );
        assert_eq!(
            codex_answers(&fields, &Map::new()),
            json!({ "answers": {} })
        );
    }
}
