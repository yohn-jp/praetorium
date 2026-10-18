import type { RepositoryDetailView, PortalUiMode } from "../presentation.js";
import { desktopRepository } from "./desktop.js";
import { mobileRepository } from "./mobile.js";

export function repositoryView(view: RepositoryDetailView, mode: PortalUiMode): string {
  return mode === "mobile" ? mobileRepository(view) : desktopRepository(view);
}
