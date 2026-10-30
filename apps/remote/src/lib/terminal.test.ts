import { describe, expect, it } from "vitest";
import { cleanTerminalOutput, exitCodeOf } from "./terminal";

describe("cleanTerminalOutput", () => {
  it("strips colors, cursor moves and OSC titles", () => {
    const raw = "\x1b[32mPASS\x1b[0m src/a.test.ts\x1b[2K\x1b[1G\n\x1b]0;title\x07done";
    expect(cleanTerminalOutput(raw).text).toBe("PASS src/a.test.ts\ndone");
  });
  it("keeps only the last state of a \\r progress bar", () => {
    const raw = "downloading 10%\rdownloading 55%\rdownloading 100%\nnext\r\nline";
    expect(cleanTerminalOutput(raw).text).toBe("downloading 100%\nnext\nline");
  });
  it("only processes the tail of huge output and says how much it left out", () => {
    const { text, hidden } = cleanTerminalOutput("x".repeat(250_000));
    expect(hidden).toBe(50_000);
    expect(text.length).toBe(200_000);
    expect(cleanTerminalOutput("hello").hidden).toBe(0);
  });
});

describe("exitCodeOf", () => {
  it("finds the exit code at the end of a failed command's output", () => {
    expect(exitCodeOf("boom\nexit code 2")).toBe("2");
    expect(exitCodeOf("Process exited with code 127\n")).toBe("127");
    expect(exitCodeOf("(exit status: 1)")).toBe("1");
    expect(exitCodeOf("all fine")).toBeNull();
  });
});

describe("cleanTerminalOutput: Bash output fence", () => {
  it("drops the markdown fence around the output", () => {
    expect(cleanTerminalOutput("```console\nhooks\n40 files\n```").text).toBe("hooks\n40 files");
  });
  it("drops a fence whose closing half has not arrived yet", () => {
    expect(cleanTerminalOutput("```console\nline 1").text).toBe("line 1");
  });
});
