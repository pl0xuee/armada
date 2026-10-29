import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "./api";
import { copyDiagnostics } from "./actions";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("./api", () => ({ api: { diagnostics: vi.fn(), saveDiagnostics: vi.fn(), openPath: vi.fn() } }));
vi.mock("@/store/app", () => ({ markRemoved: vi.fn(), suppressAgent: vi.fn(), useApp: {} }));
vi.mock("@/store/ui", () => ({ useUi: {} }));

describe("copyDiagnostics", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("copies the report and confirms", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(api.diagnostics).mockResolvedValue("REPORT");
    await copyDiagnostics();
    expect(writeText).toHaveBeenCalledWith("REPORT");
    expect(toast.success).toHaveBeenCalledWith("Diagnostics copied — paste it into your bug report");
  });

  it("reports a clipboard failure instead of claiming success", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    vi.mocked(api.diagnostics).mockResolvedValue("REPORT");
    await copyDiagnostics();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });
});
