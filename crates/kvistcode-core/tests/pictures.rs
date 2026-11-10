//! Pictures in the timeline are stored as files, not as base64 inside items: the stored
//! and sent items only name the file, the bytes are read back when needed (a message sent
//! again, a reader that wants them inline), and a client can't point a picture at any
//! other file.

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use kvistcode_core::*;
use tokio::sync::mpsc;

struct Sink(mpsc::UnboundedSender<KvistcodeEvent>);

impl EventSink for Sink {
    fn emit(&self, event: KvistcodeEvent) {
        let _ = self.0.send(event);
    }
}

mod common;

/// A 1x1 PNG, the same one the mock agent answers with.
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

async fn wait_done(
    rx: &mut mpsc::UnboundedReceiver<KvistcodeEvent>,
    events: &mut Vec<KvistcodeEvent>,
) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let ev = rx.recv().await.expect("channel open");
            let done = matches!(
                &ev,
                KvistcodeEvent::Attention {
                    reason: AttentionReason::Done,
                    ..
                }
            );
            events.push(ev);
            if done {
                return;
            }
        }
    })
    .await
    .expect("the turn finishes");
}

fn pictures_in(items: &[TimelineItem]) -> Vec<Attachment> {
    items
        .iter()
        .flat_map(|i| i.body.pictures().to_vec())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pictures_are_stored_as_files_and_read_back() {
    let data = common::scratch("pic-data");
    let project = common::scratch("pic-project");
    let log = data.join("mock.log");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let core = Core::open(data.clone(), Arc::new(Sink(tx))).unwrap();
    let mut settings = core.settings().unwrap();
    settings.custom_agents = vec![CustomAgent {
        id: "mock".into(),
        name: "Mock".into(),
        command: "python3".into(),
        args: vec![concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_pictures.py").into()],
        env: vec![KeyValue {
            name: "MOCK_LOG".into(),
            value: log.to_string_lossy().into_owned(),
        }],
        color: "#B39DDB".into(),
        enabled: true,
    }];
    core.save_settings(settings).unwrap();
    let account = core
        .accounts()
        .unwrap()
        .into_iter()
        .find(|a| a.provider == Provider::Custom)
        .unwrap()
        .id;
    let shot = Attachment {
        name: "shot.png".into(),
        mime_type: "image/png".into(),
        data: PNG.into(),
        path: None,
    };
    let agent = core
        .create_agent(CreateAgentRequest {
            provider: Provider::Custom,
            account_id: account,
            project_path: project.to_string_lossy().into_owned(),
            prompt: "look".into(),
            title: None,
            worktree: false,
            model: None,
            group_id: None,
            custom_agent_id: Some("mock".into()),
            permission_mode: None,
            attachments: vec![shot],
            config_choices: Default::default(),
        })
        .await
        .unwrap();
    let mut events = Vec::new();
    wait_done(&mut rx, &mut events).await;

    // Stored: the user's picture, the tool call's and the reply's are all just file names.
    let items = core.items(&agent.id).unwrap();
    let stored = pictures_in(&items);
    assert_eq!(stored.len(), 3, "user, tool call and reply pictures");
    for a in &stored {
        assert!(a.data.is_empty(), "no base64 in a stored item");
        let name = a.path.as_deref().expect("a file name");
        assert!(data.join("pictures").join(name).is_file());
        assert_eq!(core.read_picture(name).unwrap().data, PNG);
    }
    // The same bytes are one file.
    let files = std::fs::read_dir(data.join("pictures")).unwrap().count();
    assert_eq!(files, 1);

    // Sent: events carry only the file name too (the window loads the bytes itself).
    let sent: Vec<Attachment> = events
        .iter()
        .filter_map(|e| match e {
            KvistcodeEvent::ItemUpserted { item } => Some(item.body.pictures().to_vec()),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(!sent.is_empty());
    assert!(sent.iter().all(|a| a.data.is_empty() && a.path.is_some()));

    // The agent was given the real bytes.
    let log_text = std::fs::read_to_string(&log).unwrap();
    assert!(log_text.contains(PNG), "the agent received the picture");

    // Inline again for readers that need it.
    let mut again = items.clone();
    core.hydrate_pictures(&mut again);
    assert!(pictures_in(&again).iter().all(|a| a.data == PNG));

    // A message sent again with only the file name gets its bytes back from the file.
    let name = stored[0].path.clone().unwrap();
    core.send_prompt(
        &agent.id,
        "again",
        vec![Attachment {
            name: "shot.png".into(),
            mime_type: "image/png".into(),
            data: String::new(),
            path: Some(name.clone()),
        }],
    )
    .await
    .unwrap();
    wait_done(&mut rx, &mut events).await;
    let log_text = std::fs::read_to_string(&log).unwrap();
    assert_eq!(
        log_text.matches(PNG).count(),
        2,
        "the retry carried the bytes"
    );

    // A client can't make Kvistcode read some other file.
    for bad in ["../mock.log", "/etc/passwd", "shot.png", "..", ""] {
        let sent = core
            .send_prompt(
                &agent.id,
                "sneaky",
                vec![Attachment {
                    name: "x.png".into(),
                    mime_type: "image/png".into(),
                    data: String::new(),
                    path: Some(bad.into()),
                }],
            )
            .await;
        assert!(sent.is_err(), "{bad:?} is refused");
        assert!(core.read_picture(bad).is_err(), "{bad:?} can't be read");
    }
    core.shutdown().await;
}
