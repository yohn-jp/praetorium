import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tasksPath = path.join(root, "infrastructure/ansible/roles/observer/tasks/install.yml");
const taskText = readFileSync(tasksPath, "utf8");
const taskNames = [...taskText.matchAll(/^- name: (.+)$/gm)].map((match) => match[1]);

function task(name) {
  const marker = `- name: ${name}\n`;
  const start = taskText.indexOf(marker);
  assert.notEqual(start, -1, `missing task: ${name}`);
  const next = taskText.indexOf("\n- name: ", start + marker.length);
  return taskText.slice(start, next === -1 ? undefined : next);
}

test("Observer rollout YAML parses", () => {
  const prettier = path.join(root, "node_modules/.bin/prettier");
  const result = spawnSync(prettier, ["--parser", "yaml", tasksPath], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Observer preloads the exact rootless image before installing or starting Pull=never Quadlet", () => {
  const inspect = task("Verify exact Observer manifest access using the Observer service identity");
  const exists = task(
    "Check whether the exact Observer image digest is already in rootless storage",
  );
  const pull = task("Pull the exact Observer image digest into rootless storage");

  assert.match(
    inspect,
    /runuser[\s\S]*observer_service_user[\s\S]*podman[\s\S]*manifest[\s\S]*inspect[\s\S]*observer_image/,
  );
  assert.match(
    inspect,
    /changed_when: false[\s\S]*check_mode: false[\s\S]*timeout: 60[\s\S]*no_log: true/,
  );
  assert.match(
    exists,
    /runuser[\s\S]*observer_service_user[\s\S]*podman[\s\S]*image[\s\S]*exists[\s\S]*observer_image/,
  );
  assert.match(
    exists,
    /register: observer_image_exists[\s\S]*failed_when: false[\s\S]*check_mode: false/,
  );
  assert.match(pull, /podman[\s\S]*pull[\s\S]*observer_image/);
  assert.match(
    pull,
    /no_log: true[\s\S]*when:[\s\S]*observer_image_exists\.rc != 0[\s\S]*not ansible_check_mode/,
  );

  const ordered = [
    "Verify exact Observer manifest access using the Observer service identity",
    "Check whether the exact Observer image digest is already in rootless storage",
    "Pull the exact Observer image digest into rootless storage",
    "Install read-only Observer Quadlet",
    "Start or restart independent Observer only after configuration is valid",
  ].map((name) => taskNames.indexOf(name));
  assert.ok(ordered.every((index) => index >= 0));
  assert.deepEqual(
    ordered,
    [...ordered].sort((a, b) => a - b),
  );
  assert.match(
    readFileSync(
      path.join(
        root,
        "infrastructure/ansible/roles/observer/templates/praetorium-observer.container.j2",
      ),
      "utf8",
    ),
    /^Pull=never$/m,
  );
});

test("private registry auth is controller-validated, rootless-only, and deferred in check mode", () => {
  const source = task("Inspect operator-owned Observer registry auth source on the controller");
  assert.match(source, /path: "{{ observer_registry_auth_src }}"[\s\S]*follow: false/);
  assert.match(
    source,
    /delegate_to: localhost[\s\S]*become: false[\s\S]*when: observer_registry_auth_src \| length > 0/,
  );

  const validate = task(
    "Require a private regular Observer registry auth source owned by the controller user",
  );
  assert.match(
    validate,
    /stat\.isreg[\s\S]*not observer_registry_auth_src_stat\.stat\.islnk[\s\S]*mode == '0600'[\s\S]*pw_name == lookup\('env', 'USER'\)/,
  );

  const copy = task("Install protected Observer registry auth without revealing it");
  assert.match(
    copy,
    /src: "{{ observer_registry_auth_src }}"[\s\S]*dest: "{{ observer_registry_auth_path }}"[\s\S]*remote_src: false/,
  );
  assert.match(
    copy,
    /owner: "{{ observer_service_user }}"[\s\S]*mode: "0400"[\s\S]*backup: true[\s\S]*no_log: true[\s\S]*not ansible_check_mode/,
  );
  const deferred = task(
    "Explain deferred Observer registry authentication verification in check mode",
  );
  assert.match(deferred, /not ansible_check_mode|ansible_check_mode/);

  const manifest = task(
    "Verify exact Observer manifest access using the Observer service identity",
  );
  const pull = task("Pull the exact Observer image digest into rootless storage");
  for (const authenticatedTask of [manifest, pull])
    assert.match(authenticatedTask, /REGISTRY_AUTH_FILE[\s\S]*observer_registry_auth_path/);
  assert.match(
    manifest,
    /when: not \(ansible_check_mode and observer_registry_auth_src \| length > 0\)/,
  );

  const taskOrder = [
    "Inspect operator-owned Observer registry auth source on the controller",
    "Require a private regular Observer registry auth source owned by the controller user",
    "Install protected Observer registry auth without revealing it",
    "Verify exact Observer manifest access using the Observer service identity",
    "Pull the exact Observer image digest into rootless storage",
  ].map((name) => taskNames.indexOf(name));
  assert.deepEqual(
    taskOrder,
    [...taskOrder].sort((a, b) => a - b),
  );
  const roleDefaults = readFileSync(
    path.join(root, "infrastructure/ansible/roles/observer/defaults/main.yml"),
    "utf8",
  );
  assert.match(roleDefaults, /observer_registry_auth_src: ""/);
  assert.match(
    roleDefaults,
    /observer_registry_auth_path: "{{ observer_service_home }}\/\.config\/containers\/auth\.json"/,
  );
  const quadlet = readFileSync(
    path.join(
      root,
      "infrastructure/ansible/roles/observer/templates/praetorium-observer.container.j2",
    ),
    "utf8",
  );
  assert.doesNotMatch(quadlet, /observer_registry_auth|auth\.json/);
});

test("Observer apply waits for private readiness and requires its rootless Podman healthcheck", () => {
  const ready = task("Wait for Observer readiness on the private loopback listener");
  assert.match(ready, /url: http:\/\/127\.0\.0\.1:8791\/readyz/);
  assert.match(ready, /status_code: 200[\s\S]*return_content: false[\s\S]*timeout: 5/);
  assert.match(
    ready,
    /retries: 20[\s\S]*delay: 3[\s\S]*until: observer_ready\.status == 200[\s\S]*when: not ansible_check_mode/,
  );

  const health = task("Run the configured Podman healthcheck for Observer");
  assert.match(
    health,
    /runuser[\s\S]*observer_service_user[\s\S]*podman[\s\S]*healthcheck[\s\S]*run[\s\S]*praetorium-observer/,
  );
  assert.match(
    health,
    /changed_when: false[\s\S]*failed_when: false[\s\S]*no_log: true[\s\S]*timeout: 30[\s\S]*retries: 5[\s\S]*delay: 3[\s\S]*until: observer_podman_healthcheck\.rc == 0[\s\S]*when: not ansible_check_mode/,
  );
  const required = task("Require the Podman healthcheck to report Observer healthy");
  assert.match(required, /observer_podman_healthcheck\.rc == 0/);
  assert.match(required, /when: not ansible_check_mode/);
  const order = [
    "Start or restart independent Observer only after configuration is valid",
    "Wait for Observer readiness on the private loopback listener",
    "Run the configured Podman healthcheck for Observer",
    "Require the Podman healthcheck to report Observer healthy",
  ].map((name) => taskNames.indexOf(name));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});
