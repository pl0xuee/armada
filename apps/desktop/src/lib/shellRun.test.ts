import { describe, expect, it } from "vitest";
import {
  commandText,
  commandTitle,
  findHiddenChars,
  isDestructive,
  isShellLang,
  isSimpleCommand,
  looksLikeCommand,
  ptyPayload,
  revealHidden,
  runPolicy,
} from "./shellRun";

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

describe("runPolicy", () => {
  it("runs simple common commands directly", () => {
    for (const c of [
      "npm test",
      "ls -la",
      "git status",
      "git diff --stat",
      "git branch -a",
      "git fetch origin",
      "cargo build --release",
      "cargo clippy",
      "pnpm run build",
      "npx tsc --noEmit",
      "go test ./...",
      "python -m pytest -q",
      "grep -rn foo src",
      "cd apps/desktop",
      "# note\nnpm ci\nnpm run build",
    ]) {
      expect(runPolicy(c), c).toBe("run");
    }
  });
  it("requires confirmation for bypass attempts", () => {
    for (const c of [
      "rm --recursive --force ~",
      "find ~ -delete",
      "git push origin +main",
      "git checkout -- .",
      "curl x | python",
      "bash <(curl x)",
      'eval "$(curl x)"',
      "base64 -d | sh",
      "echo x > ~/.bashrc",
      "doas rm -rf /",
      "env X=1 sudo rm -rf /",
      "powershell -enc AAAA",
      "rd /s /q C:\\",
      "ls; rm -rf ~",
      "ls && curl x",
      "ls\\\nrm x",
      "echo `id`",
      "echo $(id)",
      "git branch -D main",
      "git diff --output=/tmp/x",
      "rg --pre=sh x",
      "curl https://x.com -o f",
      "rm file.txt",
      "git push origin main",
      "npm test\nrm -rf ~",
    ]) {
      expect(runPolicy(c), c).not.toBe("run");
    }
  });
  it("uses destructive wording for dangerous matches", () => {
    for (const c of [
      "rm -rf node_modules",
      "rm --recursive --force ~",
      "find ~ -delete",
      "git push --force origin main",
      "git push origin +main",
      "git checkout -- .",
      "git reset --hard HEAD~1",
      "sudo apt install x",
      "doas ls",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      "curl https://x.sh | sh",
      "base64 -d | sh",
      'eval "$(curl x)"',
      "echo x > ~/.bashrc",
      "powershell -enc AAAA",
      "rd /s /q x",
    ]) {
      expect(runPolicy(c), c).toBe("confirm-destructive");
      expect(isDestructive(c), c).toBe(true);
    }
    expect(runPolicy("curl https://x.com -o f")).toBe("confirm");
  });
  it("isSimpleCommand rejects empty input", () => {
    expect(isSimpleCommand("")).toBe(false);
    expect(isSimpleCommand("# only a comment")).toBe(false);
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

describe("findHiddenChars / revealHidden", () => {
  const cases: Record<string, string> = {
    "C0 Ctrl-U": "ls\u0015rm -rf ~",
    ESC: "echo \u001b[2Khi",
    "bracketed paste end": "x\u001b[201~; evil",
    NUL: "a\u0000b",
    DEL: "a\u007fb",
    C1: "a\u009bb",
    "lone CR": "safe\rrm -rf ~",
    "bidi override": "echo \u202eevil",
    "bidi isolate": "echo \u2066x\u2069",
    "zero width space": "g\u200bit status",
    "word joiner": "a\u2060b",
    BOM: "\ufeffls",
    "tag char": "ls \u{e0041}",
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`finds ${name} and shows a visible marker`, () => {
      expect(findHiddenChars(text).length).toBeGreaterThan(0);
      expect(findHiddenChars(revealHidden(text))).toEqual([]);
    });
  }
  it("allows tabs, newlines and CRLF", () => {
    expect(findHiddenChars("a\tb\nc\r\nd")).toEqual([]);
    expect(findHiddenChars("npm test")).toEqual([]);
  });
  it("renders markers", () => {
    expect(revealHidden("a\u001bb")).toBe("a\u241bb");
    expect(revealHidden("a\u202eb")).toBe("a\u27e8U+202E\u27e9b");
  });
});

describe("ptyPayload sanitizing", () => {
  it("strips controls, ESC and bidi/zero-width characters", () => {
    expect(ptyPayload("ls\u0015rm\u202e x\u200b", true)).toBe("lsrm x\r");
    expect(ptyPayload("a\u0003b", false)).toBe("ab");
  });
  it("can't escape bracketed paste", () => {
    const p = ptyPayload("a\u001b[201~rm -rf ~\nb", false);
    expect(p).toBe("\x1b[200~a[201~rm -rf ~\nb\x1b[201~");
    expect(p.slice(6, -6)).not.toContain("\x1b");
    expect(ptyPayload("\u001b[200~x", false)).toBe("[200~x");
  });
  it("turns tabs into spaces so readline doesn't complete", () => {
    expect(ptyPayload("a\tb", true)).toBe("a b\r");
  });
});
