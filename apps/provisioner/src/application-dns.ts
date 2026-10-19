import { z } from "zod";
import { applicationHostname, assignmentInstanceId, instanceHostname } from "@praetorium/contracts";
import type { RuntimeAssignment } from "@praetorium/application/lifecycle";

export interface ApplicationDnsPublisher {
  publish(
    assignment: RuntimeAssignment,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}
const RecordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean(),
  ttl: z.number().int(),
  comment: z.string().nullable().optional(),
});

/** Event-driven DNS adapter. It never polls idle instances or deletes records.
 * Cloudflare record API: https://developers.cloudflare.com/api/resources/dns/subresources/records/
 */
export class CloudflareApplicationDns implements ApplicationDnsPublisher {
  constructor(
    private readonly config: {
      zoneId: string;
      token: string;
      instanceHostnameSuffix: string;
      fetch?: typeof fetch;
    },
  ) {
    if (!/^[a-f0-9]{32}$/.test(config.zoneId) || !/^[\x21-\x7e]{32,4096}$/.test(config.token))
      throw new TypeError("Application DNS credentials are invalid");
  }

  async publish(
    assignment: RuntimeAssignment,
    beforeEffect: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const name = applicationHostname("scriptorium", assignment.repositoryId);
    if (
      assignment.deployment.hostname !== name ||
      assignment.deployment.grantPolicy.audience !== `https://${name}`
    )
      throw new Error("Application DNS assignment origin mismatch");
    const content = instanceHostname(
      assignmentInstanceId(assignment),
      this.config.instanceHostnameSuffix,
    );
    const comment = `praetorium:scriptorium:${assignment.repositoryId}:${assignment.instanceId}`;
    const read = async () => {
      const body = await this.request(
        `?name=${encodeURIComponent(name)}&per_page=100`,
        "GET",
        undefined,
        signal,
      );
      const parsed = z
        .object({
          result: z.array(RecordSchema),
          result_info: z.object({ total_count: z.number().int() }),
        })
        .parse(body);
      if (parsed.result_info.total_count !== parsed.result.length || parsed.result.length > 1)
        throw new Error("Application DNS records are ambiguous");
      const record = parsed.result[0];
      if (record && (record.name !== name || record.type !== "CNAME" || record.comment !== comment))
        throw new Error("Application DNS record is not owned by this binding");
      return record;
    };
    await beforeEffect();
    const existing = await read();
    if (!existing || existing.content !== content || existing.proxied || existing.ttl !== 60) {
      await beforeEffect();
      await this.request(
        existing ? `/${existing.id}` : "",
        existing ? "PATCH" : "POST",
        {
          type: "CNAME",
          name,
          content,
          comment,
          proxied: false,
          ttl: 60,
        },
        signal,
      );
    }
    // One bounded read after publication is record-configuration evidence only.
    // It is not a DNS resolver, public TLS, or application connectivity probe.
    await beforeEffect();
    const actual = await read();
    if (!actual || actual.content !== content || actual.proxied || actual.ttl !== 60)
      throw new Error("Application DNS publication is unconfirmed");
  }

  private async request(
    path: string,
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(5_000);
    const response = await (this.config.fetch ?? fetch)(
      `https://api.cloudflare.com/client/v4/zones/${this.config.zoneId}/dns_records${path}`,
      {
        method,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) throw new Error("Application DNS provider unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Application DNS provider returned no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65_536) {
          await reader.cancel();
          throw new Error("Application DNS response too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!z.object({ success: z.literal(true) }).safeParse(parsed).success)
      throw new Error("Application DNS operation rejected");
    return parsed;
  }
}
