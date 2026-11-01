import { describe, expect, it } from "vitest";
import { hasGithubRemote, isGithubUrl } from "./githubRemote";

describe("GitHub remotes", () => {
  it("recognises the usual spellings", () => {
    for (const url of [
      "https://github.com/o/r",
      "https://github.com/o/r.git",
      "http://www.github.com/o/r",
      "https://user:token@github.com/o/r.git",
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r.git",
      "ssh://git@github.com:22/o/r.git",
      "git://github.com/o/r.git",
      "https://GitHub.com/O/R",
    ])
      expect(isGithubUrl(url), url).toBe(true);
  });
  it("rejects other hosts and look-alikes", () => {
    for (const url of [
      "",
      "https://gitlab.com/o/r.git",
      "git@bitbucket.org:o/r.git",
      "https://github.com.evil.io/o/r",
      "https://evil.io/github.com/o/r",
      "git@notgithub.com:o/r.git",
      "https://github.com/",
      "/home/me/repo",
    ])
      expect(isGithubUrl(url), url).toBe(false);
  });
  it("needs just one GitHub remote", () => {
    expect(hasGithubRemote([])).toBe(false);
    expect(hasGithubRemote([{ url: "https://gitlab.com/o/r" }, { url: "git@github.com:o/r.git" }])).toBe(true);
  });
});
