/** Sample /diff payloads for the dev mock. */
import type { AgentDiffSummary } from "@/lib/api";
import type { Agent } from "@/lib/types";

const PATCH = `diff --git a/e2e/checkout.spec.ts b/e2e/checkout.spec.ts
new file mode 100644
--- /dev/null
+++ b/e2e/checkout.spec.ts
@@ -0,0 +1,18 @@
+import { expect, test } from "@playwright/test";
+
+test.describe("checkout", () => {
+  test("pays with a valid card", async ({ page }) => {
+    await page.goto("/checkout");
+    await page.getByLabel("Card number").fill("4242 4242 4242 4242");
+    await page.getByRole("button", { name: "Subscribe" }).click();
+    await expect(page).toHaveURL(/billing\\/success/);
+  });
+
+  test("shows an error for a declined card", async ({ page }) => {
+    await page.goto("/checkout");
+    await page.getByLabel("Card number").fill("4000 0000 0000 0002");
+    await page.getByRole("button", { name: "Subscribe" }).click();
+    await expect(page.getByRole("alert")).toContainText("declined");
+  });
+});
+
diff --git a/playwright.config.ts b/playwright.config.ts
--- a/playwright.config.ts
+++ b/playwright.config.ts
@@ -4,9 +4,11 @@ export default defineConfig({
   testDir: "./e2e",
-  timeout: 30_000,
+  timeout: 45_000,
+  retries: process.env.CI ? 1 : 0,
   use: {
     baseURL: "http://localhost:5173",
-    trace: "off",
+    trace: "retain-on-failure",
+    screenshot: "only-on-failure",
   },
 });
diff --git a/src/billing/legacy.ts b/src/billing/legacy.ts
deleted file mode 100644
--- a/src/billing/legacy.ts
+++ /dev/null
@@ -1,4 +0,0 @@
-// Old redirect-based checkout, replaced by the Payment Element.
-export function redirectToCheckout() {
-  throw new Error("removed");
-}
`;

export function mockDiff(agent: Agent): AgentDiffSummary {
  if (agent.id === "a7" || agent.id === "a8") {
    return { files: [], ahead: agent.id === "a8" ? 2 : 0, uncommitted: 0, patch: "", truncated: false, worktree: !!agent.worktree, branch: agent.branch ?? null, baseBranch: agent.baseBranch ?? "main" };
  }
  return {
    files: [
      { path: "e2e/checkout.spec.ts", status: "added", additions: 17, deletions: 0 },
      { path: "playwright.config.ts", status: "modified", additions: 4, deletions: 2 },
      { path: "src/billing/legacy.ts", status: "deleted", additions: 0, deletions: 4 },
    ],
    ahead: 1,
    uncommitted: 3,
    patch: PATCH,
    truncated: false,
    worktree: !!agent.worktree,
    branch: agent.branch ?? null,
    baseBranch: agent.baseBranch ?? "main",
  };
}
