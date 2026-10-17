import { describe, expect, it, vi } from "vitest";
import { notifyWorkAvailable } from "./work-notifications.js";

describe("work availability delivery", () => {
  const env = {
    BUILD_WORK_NOTIFICATION_URL: "https://build.test/internal/work-available",
    BUILD_WORK_NOTIFICATION_TOKEN: "dedicated-notification-token-00000000000",
  };

  it("sends only a hint and forbids credential-bearing redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    expect(await notifyWorkAvailable(env, "build", fetcher)).toBe("notified");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(env.BUILD_WORK_NOTIFICATION_URL);
    expect(request?.redirect).toBe("error");
    expect(JSON.parse(request?.body as string)).toEqual({ version: 1, kind: "build" });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps dropped notifications separate from durable execution and never retries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network unavailable"));
    expect(await notifyWorkAvailable(env, "build", fetcher)).toBe("failed");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await notifyWorkAvailable({}, "build", fetcher)).toBe("disabled");
    expect(
      await notifyWorkAvailable(
        { ...env, BUILD_WORK_NOTIFICATION_URL: "http://build.test/internal/work-available" },
        "build",
        fetcher,
      ),
    ).toBe("failed");
    expect(
      await notifyWorkAvailable(
        {
          ...env,
          BUILD_WORK_NOTIFICATION_URL: "https://build.test/internal/work-available?secret=x",
        },
        "build",
        fetcher,
      ),
    ).toBe("failed");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
