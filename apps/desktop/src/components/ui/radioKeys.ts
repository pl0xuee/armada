import type { KeyboardEvent } from "react";

/**
 * WAI-ARIA radio group keyboard pattern for a container of role="radio" buttons:
 * arrows move and select (wrapping), Home/End jump to the ends; disabled radios are skipped.
 * Pair with a roving tabindex (checked radio tabIndex=0, others -1).
 */
export function onRadioGroupKeyDown(e: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')).filter(
    (r) => !(r as HTMLButtonElement).disabled && r.getAttribute("aria-disabled") !== "true",
  );
  if (radios.length === 0) return;
  const cur = radios.findIndex((r) => r === document.activeElement);
  let next = cur;
  if (e.key === "Home") next = 0;
  else if (e.key === "End") next = radios.length - 1;
  else if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % radios.length;
  else next = (cur - 1 + radios.length) % radios.length;
  e.preventDefault();
  const target = radios[next];
  target.focus();
  // Selection follows focus (standard radio behaviour).
  target.click();
}
