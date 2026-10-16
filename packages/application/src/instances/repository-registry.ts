import type { RepositoryBinding } from "@praetorium/contracts";
import type {
  RepositoryActor,
  RepositoryLocator,
  RepositoryRegistryInput,
  RepositoryRegistryStore,
  RepositorySnapshot,
  RevalidateBindingInput,
  SuspendBindingInput,
} from "./types.js";
import {
  RepositoryBindingSuspended,
  RepositoryNotFound,
  RepositoryStateConflict,
} from "./types.js";

export type IdFactory = () => string;

export class RepositoryRegistryService {
  constructor(
    private readonly store: RepositoryRegistryStore,
    private readonly newInstanceId: IdFactory,
  ) {}

  async resolveOrCreate(input: RepositoryRegistryInput): Promise<{
    readonly binding: RepositoryBinding;
    readonly instance: RepositorySnapshot["instance"];
    readonly created: boolean;
  }> {
    validateRepositoryLocator(input.repository);
    if (!input.actor.id || !input.idempotencyKey || !input.requestId) {
      throw new TypeError("actor, request ID, and idempotency key are required");
    }
    const { snapshot, created } = await this.store.resolveOrCreate({
      ...input,
      instanceId: this.newInstanceId(),
    });
    if (snapshot.binding.suspended) {
      throw new RepositoryBindingSuspended();
    }
    if (!sameLocator(snapshot.binding, input.repository)) {
      await this.store.suspendBinding({
        repositoryId: input.repository.repositoryId,
        expectedBindingEpoch: snapshot.binding.bindingEpoch,
        eventId: `locator-change:${input.repository.repositoryId}:${snapshot.binding.bindingEpoch}`,
        eventKind: "repository.locator_changed",
        reason: "repository installation or locator changed; revalidation required",
        requestId: input.requestId,
        now: input.now,
      });
      throw new RepositoryBindingSuspended(
        "repository installation or locator changed; revalidation required",
      );
    }
    return { binding: snapshot.binding, instance: snapshot.instance, created };
  }

  async getByRepositoryId(repositoryId: number): Promise<RepositorySnapshot | null> {
    assertRepositoryId(repositoryId);
    return this.store.getByRepositoryId(repositoryId);
  }

  async getByInstanceId(instanceId: string): Promise<RepositorySnapshot | null> {
    if (!instanceId) throw new TypeError("instance ID is required");
    return this.store.getByInstanceId(instanceId);
  }

  async suspendBinding(input: SuspendBindingInput): Promise<RepositoryBinding> {
    const binding = await this.store.suspendBinding(input);
    if (!binding) throw new RepositoryNotFound();
    return binding;
  }

  async revalidateBinding(input: RevalidateBindingInput): Promise<RepositoryBinding> {
    validateRepositoryLocator({
      repositoryId: input.repositoryId,
      installationId: input.installationId,
      owner: input.owner,
      name: input.name,
      authorizationRevision: input.authorizationRevision,
    });
    const binding = await this.store.revalidateBinding(input);
    if (!binding)
      throw new RepositoryStateConflict("binding epoch changed or binding is not suspended");
    return binding;
  }
}

export function validateRepositoryLocator(repository: RepositoryLocator): void {
  assertRepositoryId(repository.repositoryId);
  if (!Number.isSafeInteger(repository.installationId) || repository.installationId <= 0) {
    throw new TypeError("installation ID must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(repository.authorizationRevision) ||
    repository.authorizationRevision < 0
  ) {
    throw new TypeError("authorization revision must be a non-negative safe integer");
  }
  if (
    !/^[A-Za-z0-9_.-]{1,255}$/u.test(repository.owner) ||
    !/^[A-Za-z0-9_.-]{1,255}$/u.test(repository.name)
  ) {
    throw new TypeError("repository owner and name must be valid GitHub locators");
  }
}

export function assertRepositoryId(repositoryId: number): void {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new TypeError("repository ID must be a positive safe integer");
  }
}

function sameLocator(binding: RepositoryBinding, repository: RepositoryLocator): boolean {
  return (
    binding.repositoryId === repository.repositoryId &&
    binding.installationId === repository.installationId &&
    binding.owner.toLowerCase() === repository.owner.toLowerCase() &&
    binding.name.toLowerCase() === repository.name.toLowerCase()
  );
}

export type { RepositoryActor };
