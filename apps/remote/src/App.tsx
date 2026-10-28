import { useEffect } from "react";
import { Toasts } from "./components/Toasts";
import { ensureTimeline } from "./lib/controller";
import { navigate, useRoute } from "./lib/router";
import { useInbox } from "./lib/selectors";
import { useStore } from "./lib/store";
import { AgentDetail } from "./screens/AgentDetail";
import { Fleet } from "./screens/Fleet";
import { Inbox } from "./screens/Inbox";
import { Blocked, Boot, Pairing } from "./screens/Pairing";

export function App() {
  const phase = useStore((s) => s.phase);
  return (
    <>
      {phase === "boot" && <Boot />}
      {phase === "unpaired" && <Pairing />}
      {phase === "blocked" && <Blocked />}
      {phase === "ready" && <Paired />}
      <Toasts />
    </>
  );
}

function Paired() {
  const route = useRoute();
  const session = useStore((s) => s.session);
  useDocumentTitle();

  const viewerAgent = session?.scope === "viewer" ? session.agentId : null;

  // A read-only link only ever shows its one agent.
  useEffect(() => {
    if (viewerAgent && (route.name !== "agent" || route.agentId !== viewerAgent)) {
      navigate({ name: "agent", agentId: viewerAgent }, { replace: true });
    }
  }, [route, viewerAgent]);

  useEffect(() => {
    if (route.name === "agent") ensureTimeline(route.agentId);
  }, [route]);

  if (viewerAgent) return <AgentDetail key={viewerAgent} agentId={viewerAgent} />;
  switch (route.name) {
    case "agent":
      return (
        <div key={route.agentId} className="animate-enter-right">
          <AgentDetail agentId={route.agentId} />
        </div>
      );
    case "inbox":
      return (
        <div key="inbox" className="animate-enter-right">
          <Inbox />
        </div>
      );
    default:
      return (
        <div key="fleet" className="animate-fade">
          <Fleet />
        </div>
      );
  }
}

function useDocumentTitle() {
  const { count } = useInbox();
  useEffect(() => {
    document.title = count > 0 ? `(${count}) Armada` : "Armada";
  }, [count]);
}
