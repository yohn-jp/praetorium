import { SourceProducerResultSchema, type SourceProducerResult } from "@praetorium/contracts";
import type { IngestReleaseResult } from "@praetorium/application/releases";
import type { D1SourceReleaseBuildQueue, SourceJob } from "./source-release-builds.js";

type ProgressionQueue = Pick<D1SourceReleaseBuildQueue, "claimProduced" | "markAdmitted" | "rejectProduced" | "deferProduced">;

export async function progressProducedSourceReleases(input: {
  readonly queue: ProgressionQueue;
  readonly admissionLeaseMs: number;
  readonly admit: (job: SourceJob, result: SourceProducerResult) => Promise<IngestReleaseResult>;
  readonly progressAdmitted: () => Promise<unknown>;
}): Promise<void> {
  for (let processed = 0; processed < 25; processed += 1) {
    // Start each lease when its verification starts, not while another job waits on OCI.
    const [job] = await input.queue.claimProduced(1, input.admissionLeaseMs);
    if (!job) return;
    const attempt = job.admission_attempt;
    let result: SourceProducerResult;
    try {
      result = SourceProducerResultSchema.parse(JSON.parse(job.result_json));
    } catch {
      await input.queue.rejectProduced(job.job_id, "SOURCE_RESULT_INVALID", attempt);
      continue;
    }
    try {
      const decision = await input.admit(job, result);
      if (decision.kind === "admitted") {
        if (await input.queue.markAdmitted(job.job_id, decision.candidate.id, attempt))
          await input.progressAdmitted();
      } else if (decision.kind === "denied") {
        await input.queue.rejectProduced(job.job_id, "ADMISSION_DENIED", attempt);
      } else {
        await input.queue.deferProduced(job.job_id, attempt);
      }
    } catch {
      await input.queue.deferProduced(job.job_id, attempt);
    }
  }
}
