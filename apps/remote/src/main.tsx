import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { boot } from "./lib/controller";
import { trackKeyboard, trackVisibility } from "./lib/viewport";
import "./styles.css";

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

trackKeyboard();
trackVisibility();
void boot();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
