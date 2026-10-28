import { useEffect, useRef } from "react";

/**
 * Run the latest `commit` when the component unmounts. Fields that save on blur don't get a
 * blur when the section or view is switched by keyboard shortcut, so commit then too.
 * Commit functions must be idempotent (no-op when the value is already saved).
 */
export function useCommitOnUnmount(commit: () => void) {
  const ref = useRef(commit);
  ref.current = commit;
  useEffect(() => () => ref.current(), []);
}
