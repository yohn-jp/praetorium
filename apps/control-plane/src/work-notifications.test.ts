import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyWorkAvailable } from "./work-notifications.js";

describe("work availability delivery", () => {
  afterEach(() => vi.restoreAllMocks());
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
    expect(request?.redirect).toBe("manual");
    expect(JSON.parse(request?.body as string)).toEqual({ version: 1, kind: "build" });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not follow a redirect and treats it as a dropped hint", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 307, headers: { Location: "https://other.test/" } }),
      );

    expect(await notifyWorkAvailable(env, "build", fetcher)).toBe("failed");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("scopes operation metadata hints and rejects scoped build hints", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const operationEnv = {
      PROVISIONER_WORK_NOTIFICATION_URL: "https://runtime.test/internal/work-available",
      PROVISIONER_WORK_NOTIFICATION_TOKEN: env.BUILD_WORK_NOTIFICATION_TOKEN,
    };
    expect(await notifyWorkAvailable(operationEnv, "operation", fetcher, "instance-1")).toBe("notified");
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      version: 1, kind: "operation", instanceId: "instance-1",
    });
    expect(await notifyWorkAvailable(env, "build", fetcher, "instance-1")).toBe("failed");
    expect(fetcher).toHaveBeenCalledOnce();
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

  it("records sanitized delivery outcomes without endpoint, instance or credential data", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private upstream body"));
    await notifyWorkAvailable({}, "build", fetcher);
    await notifyWorkAvailable(env, "build", fetcher);
    fetcher.mockResolvedValue(new Response(null, { status: 202 }));
    await notifyWorkAvailable(env, "build", fetcher);
    expect(log.mock.calls).toEqual(
      ["disabled", "failed", "notified"].map((outcome) => [
        JSON.stringify({ event: "work_notification", kind: "build", outcome }),
      ]),
    );
  });
});
