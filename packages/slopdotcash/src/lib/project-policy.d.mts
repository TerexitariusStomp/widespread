/** Types for project policy transition checks. */

import type { ProjectDefinition } from "./projects.mjs";

export declare function assertProjectPolicyTransition(
  previousValue: unknown,
  nextValue: unknown,
): ProjectDefinition;
