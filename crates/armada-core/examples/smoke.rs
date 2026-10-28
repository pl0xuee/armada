//! Live smoke test against the real agent CLIs:
//!   cargo run -p armada-core --example smoke -- <data_dir> <project_dir> <claude|codex|grok> "<prompt>"
//! Prints every event, auto-approves the first "allow once" option, exits when the turn ends.

use std::sync::Arc;
use std::time::Duration;

use armada_core::*;

struct Printer(tokio::sync::mpsc::UnboundedSender<ArmadaEvent>);

impl EventSink for Printer {
    fn emit(&self, event: ArmadaEvent) {
        let _ = self.0.send(event);
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (data, project, provider, prompt) = (&args[1], &args[2], &args[3], &args[4]);
    let provider = Provider::parse(provider).expect("provider");
    providers::augment_path();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let core = Core::open(data.into(), Arc::new(Printer(tx)))?;
    let account = core
        .accounts()?
        .into_iter()
        .find(|a| a.provider == provider && a.is_system)
        .unwrap();
    let agent = core
        .create_agent(CreateAgentRequest {
            provider,
            account_id: account.id,
            project_path: project.clone(),
            prompt: prompt.clone(),
            title: None,
            worktree: std::env::var("WT").is_ok(),
            model: None,
            group_id: None,
            custom_agent_id: None,
            permission_mode: None,
            attachments: vec![],
        })
        .await?;
    println!(
        "created {} cwd={} branch={:?}",
        agent.id, agent.cwd, agent.branch
    );
    let deadline = tokio::time::sleep(Duration::from_secs(240));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => { println!("TIMEOUT"); break; }
            ev = rx.recv() => {
                let Some(ev) = ev else { break };
                match &ev {
                    ArmadaEvent::TextDelta { delta, .. } => { print!("{delta}"); continue; }
                    ArmadaEvent::AgentUpdated { agent } => println!(
                        "\n[agent] status={:?} running={} session={:?} cost={} tokens={} ctx={:?}/{:?} title={:?} opts={}",
                        agent.status, agent.running, agent.session_id, agent.cost_usd, agent.tokens_used,
                        agent.context_used, agent.context_size, agent.title,
                        agent.config_options.iter().map(|o| format!("{}={}", o.id, o.current_value)).collect::<Vec<_>>().join(",")
                    ),
                    ArmadaEvent::ItemUpserted { item } => {
                        let j = serde_json::to_string(item).unwrap();
                        println!("\n[item] {}", &j[..j.len().min(400)]);
                        if let ItemBody::Permission { request_id, options, resolution: None, .. } = &item.body {
                            let opt = options.iter().find(|o| o.kind == PermissionOptionKind::AllowOnce).unwrap();
                            core.respond_permission(&agent.id, request_id, &opt.id).await?;
                        }
                    }
                    ArmadaEvent::Attention { reason, body, .. } => {
                        println!("\n[attention] {reason:?}: {body}");
                        if *reason != AttentionReason::Permission { break; }
                    }
                    other => println!("\n[event] {other:?}"),
                }
            }
        }
    }
    if std::env::var("RESUME").is_ok() {
        println!("\n=== stopping and resuming ===");
        core.stop_agent(&agent.id).await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        core.send_prompt(
            &agent.id,
            "What was the exact text of my first message? Answer in one line.",
            vec![],
        )
        .await?;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(180)) => { println!("TIMEOUT"); break; }
                ev = rx.recv() => match ev {
                    Some(ArmadaEvent::TextDelta { delta, .. }) => print!("{delta}"),
                    Some(ArmadaEvent::Attention { reason, body, .. }) => { println!("\n[attention] {reason:?}: {body}"); break; }
                    Some(ArmadaEvent::ItemUpserted { item }) => {
                        if let ItemBody::Notice { text, .. } = &item.body { println!("\n[notice] {text}"); }
                    }
                    _ => {}
                }
            }
        }
    }
    println!("\nitems in db: {}", core.items(&agent.id)?.len());
    core.shutdown().await;
    Ok(())
}
