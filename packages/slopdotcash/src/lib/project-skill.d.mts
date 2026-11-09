/** Types for the generated project skill renderer. */

import type { ProjectDefinition } from "./projects.mjs";

export declare function renderProjectSkill(input: {
  role: "contributor" | "reviewer";
  templateFiles: Record<string, string | Uint8Array>;
  manifest: Pick<
    ProjectDefinition,
    "id" | "skill" | "reviewSkill" | "repositories" | "contribution"
  >;
  registry: { revision: number; manifestSha256: string };
}): Record<string, Uint8Array>;
export declare function usesGeneratedSkills(
  manifest: Pick<
    ProjectDefinition,
    "id" | "skill" | "reviewSkill" | "repositories" | "contribution"
  >,
): boolean;
export declare function publishesGeneratedSkills(
  manifest: Pick<
    ProjectDefinition,
    "id" | "skill" | "reviewSkill" | "repositories" | "contribution"
  >,
): boolean;
