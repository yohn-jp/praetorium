import type { RepositoryListView, PortalUiMode } from "../presentation.js";
import { desktopRepositories } from "./desktop.js";
import { mobileRepositories } from "./mobile.js";

export function repositoryListView(view: RepositoryListView, mode: PortalUiMode): string {
  return mode === "mobile" ? mobileRepositories(view) : desktopRepositories(view);
}
