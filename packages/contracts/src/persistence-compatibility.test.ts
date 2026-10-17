import { expect, it } from "vitest";
import {
  PersistenceCompatibilitySchema,
  PersistenceObservationSchema,
} from "./persistence-compatibility.js";

it("requires directional readers for all writable versions, retaining mixed remote versions", () => {
  const declaration = {
    contractVersion: "scriptorium-persistence/v1",
    readable: [{ formatId: "scriptorium.git-proposals", versions: [1, 2] }],
    writable: [
      { formatId: "scriptorium.git-proposals", version: 1 },
      { formatId: "scriptorium.git-proposals", version: 2 },
    ],
  };
  expect(PersistenceCompatibilitySchema.safeParse(declaration).success).toBe(true);
  expect(
    PersistenceCompatibilitySchema.safeParse({
      ...declaration,
      readable: [{ formatId: "scriptorium.git-proposals", versions: [1] }],
    }).success,
  ).toBe(false);
  expect(
    PersistenceCompatibilitySchema.safeParse({
      ...declaration,
      writable: [...declaration.writable, declaration.writable[0]],
    }).success,
  ).toBe(false);
  expect(
    PersistenceObservationSchema.safeParse({
      state: "verified",
      observedRemoteCommit: "a".repeat(40),
      formats: declaration.writable,
    }).success,
  ).toBe(true);
});

it("retains the original remote confirmation timestamp without requiring it on historical observations", () => {
  const observation = { state: "verified", observedRemoteCommit: "a".repeat(40), formats: [] };
  expect(PersistenceObservationSchema.parse(observation)).toEqual(observation);
  expect(
    PersistenceObservationSchema.parse({
      ...observation,
      remoteObservedAt: "2026-10-17T00:00:00.000Z",
    }).remoteObservedAt,
  ).toBe("2026-10-17T00:00:00.000Z");
  expect(
    PersistenceObservationSchema.safeParse({ ...observation, remoteObservedAt: "not-a-time" })
      .success,
  ).toBe(false);
});
