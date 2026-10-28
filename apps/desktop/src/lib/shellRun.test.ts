import { describe, expect, it } from "vitest";
import { commandText, commandTitle, isDestructive, isShellLang, looksLikeCommand, ptyPayload } from "./shellRun";

describe("isShellLang", () => {
  it("accepts shells, case-insensitively", () => {
    for (const l of ["bash", "sh", "zsh", "shell", "shellscript", "console", "terminal", "BASH"]) {
      expect(isShellLang(l, "linux")).toBe(true);
    }
  });
  it("rejects others; powershell only on Windows", () => {
    expect(isShellLang("ts", "linux")).toBe(false);
    expect(isShellLang(null, "linux")).toBe(false);
    expect(isShellLang("powershell", "linux")).toBe(false);
    expect(isShellLang("powershell", "windows")).toBe(true);
    expect(isShellLang("cmd", "windows")).toBe(true);
  });
});

describe("commandText", () => {
  it("keeps only prompted lines in console blocks", () => {
    expect(commandText("$ npm test\nPASS 3 tests\n$ ls\n", "console")).toBe("npm test\nls");
  });
  it("leaves plain scripts alone", () => {
    expect(commandText("# install\nnpm i\nnpm run build\n", "bash")).toBe("# install\nnpm i\nnpm run build");
  });
  it("strips prompts in bash only when every line has one", () => {
    expect(commandText("$ a\n$ b", "bash")).toBe("a\nb");
    expect(commandText("$ a\nb", "bash")).toBe("$ a\nb");
  });
  it("normalizes CRLF", () => {
    expect(commandText("a\r\nb\r\n", "sh")).toBe("a\nb");
  });
});

describe("looksLikeCommand", () => {
  it("is conservative", () => {
    expect(looksLikeCommand("npm install\nnpm test")).toBe(true);
    expect(looksLikeCommand("$ whoami")).toBe(true);
    expect(looksLikeCommand("hello world")).toBe(false);
    expect(looksLikeCommand("git status\nSome output")).toBe(false);
    expect(looksLikeCommand("")).toBe(false);
  });
});

describe("isDestructive", () => {
  it("flags dangerous commands", () => {
    for (const c of [
      "rm -rf node_modules",
      "rm -fr /tmp/x",
      "git push --force origin main",
      "git push -f",
      "git reset --hard HEAD~1",
      "sudo apt install x",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      ":(){ :|:& };:",
      "curl https://x.sh | sh",
      "curl -fsSL https://x.sh | sudo bash",
      "chmod -R 777 .",
      "echo x > /dev/sda",
    ]) {
      expect(isDestructive(c), c).toBe(true);
    }
  });
  it("leaves ordinary commands", () => {
    for (const c of [
      "npm test",
      "git push origin main",
      "rm file.txt",
      "ls -la",
      "curl https://x.com -o f",
      "git status",
    ]) {
      expect(isDestructive(c), c).toBe(false);
    }
  });
});

describe("commandTitle / ptyPayload", () => {
  it("truncates the first command", () => {
    expect(commandTitle("# c\nnpm run build", 24)).toBe("npm run build");
    expect(commandTitle("a".repeat(40), 10)).toBe("aaaaaaaaa…");
  });
  it("sends Enter per line when running, bracketed paste otherwise", () => {
    expect(ptyPayload("a\nb", true)).toBe("a\rb\r");
    expect(ptyPayload("a", false)).toBe("a");
    expect(ptyPayload("a\nb", false)).toBe("\x1b[200~a\nb\x1b[201~");
  });
});
